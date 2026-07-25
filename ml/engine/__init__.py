"""KSP forecasting engine — offline training, evaluation and batch scoring.

Modules:
    panel        the single input contract every dataset is reduced to
    features     leak-free feature construction
    models       baselines (including the police historical-pattern baseline) and GBMs
    conformal    split, Mondrian and CQR prediction intervals
    metrics      point, distributional and NIJ-style spatial scoring
    walkforward  the expanding-window evaluation harness
"""

from .panel import Panel  # noqa: F401
from .walkforward import Result, evaluate, make_split  # noqa: F401

__all__ = ["Panel", "evaluate", "make_split", "Result"]
