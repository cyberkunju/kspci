"""
Tier-3: a global neural spatio-temporal forecaster trained on the RTX 4060, evaluated
head-to-head against the GBM on the SAME real-data walk-forward protocol.

Architecture (one model shared across all cells):
  - per-cell learned embedding
  - GRU encoder over the last L days of [log-count, near-repeat neighbour log-count,
    day-of-week sin/cos, weekend, holiday, tmax, precip]  (spatio-temporal + covariates)
  - head: concat(GRU state, cell embedding, target-day covariates) -> MLP -> softplus
  - Poisson NLL loss (count data), Adam, early stop on a temporal validation split.

Leak-free: input window for day t uses only days < t; train on [warm, tune_start],
early-stop on [tune_start, test_start], test on [test_start, T]. Reports MASE / PAI / PEI
/ 90% conformal coverage, comparable to eval_daily.py.

Usage: python train_neural.py --unit grid --grid-m 700 --test-days 120 --epochs 8
"""
import argparse, json, sys, math, time
import numpy as np, pandas as pd
import torch, torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from eval_daily import build_panel, cov_matrix, adjacency, pai_curve

DEV = "cuda" if torch.cuda.is_available() else "cpu"
L = 28  # history window (days)


def make_channels(M, C, Adj):
    """Return per-day channel tensor S: (units, days, F) built leak-free from panel+cov."""
    B, T = M.shape
    logM = np.log1p(M)
    nb = (Adj @ M) if Adj is not None else np.zeros_like(M)
    lognb = np.log1p(nb)
    # broadcast covariate columns we want inside the sequence
    # C columns order (from cov_matrix): dow_sin,dow_cos,doy_sin,doy_cos,is_weekend,is_holiday,is_payday,tmax,precip,snow,wind
    idx = {"dow_sin":0,"dow_cos":1,"is_weekend":4,"is_holiday":5,"tmax":7,"precip":8}
    seq_cov = np.stack([np.tile(C[:, i], (B, 1)) for i in idx.values()], axis=2)  # (B,T,6)
    S = np.concatenate([logM[..., None], lognb[..., None], seq_cov], axis=2)  # (B,T,8)
    return S.astype(np.float32)


class WinDS(Dataset):
    def __init__(self, S, M, C, units_idx, day_range):
        self.S = S; self.M = M; self.C = C.astype(np.float32)
        self.pairs = [(u, t) for t in day_range for u in units_idx]
    def __len__(self): return len(self.pairs)
    def __getitem__(self, i):
        u, t = self.pairs[i]
        x = self.S[u, t - L:t]                 # (L, F)
        cov_t = self.C[t]                      # (ncov,)
        y = self.M[u, t]
        return x, cov_t, u, np.float32(y)


class STNet(nn.Module):
    def __init__(self, n_units, f_seq, f_cov, emb=16, hid=64):
        super().__init__()
        self.emb = nn.Embedding(n_units, emb)
        self.gru = nn.GRU(f_seq, hid, batch_first=True)
        self.head = nn.Sequential(nn.Linear(hid + emb + f_cov, 96), nn.ReLU(),
                                  nn.Dropout(0.1), nn.Linear(96, 1))
    def forward(self, x, cov, u):
        _, h = self.gru(x)                     # h: (1,B,hid)
        z = torch.cat([h[-1], self.emb(u), cov], dim=1)
        return torch.nn.functional.softplus(self.head(z)).squeeze(-1) + 1e-4


def run(M, days, C, Adj, test_days=120, tune_days=90, warm=400, epochs=8, bs=4096):
    B, T = M.shape
    S = make_channels(M, C, Adj)
    # standardize sequence channels (except keep log-counts interpretable-ish) + covariates
    mu, sd = S.reshape(-1, S.shape[2]).mean(0), S.reshape(-1, S.shape[2]).std(0) + 1e-6
    S = (S - mu) / sd
    Cn = (C - C.mean(0)) / (C.std(0) + 1e-6)
    test_start = T - test_days; tune_start = test_start - tune_days
    units_idx = list(range(B))
    tr = DataLoader(WinDS(S, M, Cn, units_idx, range(warm, tune_start)), batch_size=bs, shuffle=True, num_workers=0)
    va = DataLoader(WinDS(S, M, Cn, units_idx, range(tune_start, test_start)), batch_size=bs, shuffle=False)

    net = STNet(B, S.shape[2], C.shape[1]).to(DEV)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    lossf = nn.PoissonNLLLoss(log_input=False, full=True)
    best, best_state = 1e9, None
    for ep in range(epochs):
        net.train(); t0 = time.time()
        for x, cov, u, y in tr:
            x, cov, u, y = x.to(DEV), cov.to(DEV), u.to(DEV), y.to(DEV)
            opt.zero_grad(); pred = net(x, cov, u); loss = lossf(pred, y)
            loss.backward(); opt.step()
        net.eval(); ve, vn = 0.0, 0
        with torch.no_grad():
            for x, cov, u, y in va:
                x, cov, u, y = x.to(DEV), cov.to(DEV), u.to(DEV), y.to(DEV)
                ve += torch.abs(net(x, cov, u) - y).sum().item(); vn += len(y)
        vmae = ve / vn
        print(f"  epoch {ep+1}/{epochs}  val MAE {vmae:.4f}  ({time.time()-t0:.1f}s)")
        if vmae < best: best, best_state = vmae, {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
    net.load_state_dict(best_state)

    # conformal q90 on validation residuals
    net.eval(); resid = []
    with torch.no_grad():
        for x, cov, u, y in va:
            p = net(x.to(DEV), cov.to(DEV), u.to(DEV)).cpu().numpy()
            resid.append(np.abs(p - y.numpy()))
    resid = np.concatenate(resid); n = len(resid)
    conf_q = float(np.quantile(resid, min(1.0, np.ceil((n+1)*0.9)/n)))

    # test walk-forward (leak-free: windows use only past days)
    budgets = (0.01, 0.02, 0.05, 0.10, 0.20)
    abse, sqe, naive = [], [], []
    pai = {b: [] for b in budgets}; pei = {b: [] for b in budgets}
    cov_hit = cov_n = 0
    with torch.no_grad():
        for t in range(test_start, T):
            x = torch.tensor(S[:, t - L:t]).to(DEV)
            covt = torch.tensor(np.tile(Cn[t], (B, 1)), dtype=torch.float32).to(DEV)
            u = torch.arange(B).to(DEV)
            pred = net(x, covt, u).cpu().numpy()
            actual = M[:, t]
            abse.append(np.abs(pred - actual)); sqe.append((pred - actual) ** 2)
            naive.append(np.abs(actual - M[:, t - 7]))
            pc = pai_curve(pred, actual, budgets)
            for b in budgets: pai[b].append(pc[b][0]); pei[b].append(pc[b][1])
            lo = np.maximum(0, pred - conf_q); hi = pred + conf_q
            cov_hit += int(((actual >= lo) & (actual <= hi)).sum()); cov_n += B
    nmae = np.mean(np.concatenate(naive))
    mae = np.mean(np.concatenate(abse)); rmse = math.sqrt(np.mean(np.concatenate(sqe)))
    rep = {"model": "neural_stnet_gpu", "device": DEV,
           "config": {"units": B, "days": T, "test_days": test_days, "window": L, "epochs": epochs},
           "point": {"MAE": round(mae, 4), "RMSE": round(rmse, 4), "MASE": round(mae / nmae, 4)},
           "spatial": {f"{int(b*100)}%": {"PAI": round(float(np.nanmean(pai[b])), 3),
                        "PEI": round(float(np.nanmean(pei[b])), 3)} for b in budgets},
           "calibration": {"target": 0.9, "empirical_coverage": round(cov_hit / cov_n, 4), "conformal_q90": round(conf_q, 3)}}
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/chicago.parquet")
    ap.add_argument("--cov", default="data/covariates.parquet")
    ap.add_argument("--unit", default="grid", choices=["beat", "grid"])
    ap.add_argument("--grid-m", type=int, default=700)
    ap.add_argument("--test-days", type=int, default=120)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--out", default="data/eval_neural.json")
    args = ap.parse_args()
    df = pd.read_parquet(args.data); cov = pd.read_parquet(args.cov)
    M, units, dys = build_panel(df, args.unit, args.grid_m)
    Adj = adjacency(units) if args.unit == "grid" else None
    C, _ = cov_matrix(dys, cov)
    print(f"[{DEV}] panel {M.shape[0]} {args.unit}s x {M.shape[1]} days; training neural ST model…")
    rep = run(M, dys, C, Adj, test_days=args.test_days, epochs=args.epochs)
    json.dump(rep, open(args.out, "w"), indent=2)
    print("\n============ TIER-3 NEURAL (GPU) REAL-DATA EVAL ============")
    print(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
