'use strict';

/**
 * All-India crime-data generator — NCRB-calibrated ETAS/Hawkes simulation.
 *
 * Geography  : all 640 Census 2011 districts across 36 states/UTs, each with real
 *              boundaries, real demography, and ~154,800 real localities grouped
 *              into 9,700 taluks. Built by build-geo.js.
 * Taxonomy   : 186 real NCRB crime heads in 16 operational groups, weighted by
 *              published 2022 all-India case counts (ncrb_crime_heads_2022.json).
 * Volume     : each state's case total is anchored on its real NCRB 2023 count,
 *              then split across districts by population and urban share.
 * Outcomes   : chargesheet and conviction follow each state's real 2023 rates.
 * Demography : complainant and victim caste, religion, occupation and age are
 *              drawn from that district's actual census distributions.
 *
 * Why the output has realistic variance rather than uniform noise:
 *   - State volumes are real, so Kerala and Delhi are dense while Nagaland and
 *     Sikkim are sparse, across a ~19x spread that matches reality.
 *   - Head mix is tilted per state by that state's real murder, rape, kidnapping,
 *     extortion and robbery rates, so the severity profile differs by region.
 *   - Offences that only exist in some states (the Prohibition Act) are generated
 *     only there.
 *   - Incidents land on real localities inside real district boundaries, and the
 *     police station follows the locality's taluk.
 *   - Crime is a self-exciting spatio-temporal point process, producing
 *     near-repeat clustering, seasonality, weekly cycles and organised rings.
 *
 * Usage:
 *   node datastore/generate-india.js --cases 1500000
 *   node datastore/generate-india.js --cases 200000 --years 3
 *
 * Rows are streamed to disk as they are built, so output size is not bounded by
 * memory. See the scale note printed at the end for the Data Store ceiling.
 */

const fs = require('fs');
const path = require('path');

const REF_DIR = path.join(__dirname, 'ref');
const SEED_DIR = path.join(__dirname, 'seed');
const TRAIN_DIR = path.join(__dirname, 'train');
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.mkdirSync(TRAIN_DIR, { recursive: true });

// ---------------- CLI ----------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const TARGET_CASES = parseInt(arg('cases', '1500000'), 10);
const YEARS_SPAN = parseFloat(arg('years', '3'));
const SEED = parseInt(arg('seed', '20260725'), 10);

// ---------------- seeded RNG ----------------
let _s = SEED >>> 0;
function rand() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
const pick = (a) => a[Math.floor(rand() * a.length)];
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const chance = (p) => rand() < p;
function gauss(mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(gauss(lambda, Math.sqrt(lambda))));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}
/** Draw an index from unnormalised weights. */
function weightedIndex(weights, total) {
  let r = rand() * (total === undefined ? weights.reduce((a, b) => a + b, 0) : total);
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
/** Draw a key from a {key: share} map. Shares need not sum to 1. */
function weightedKey(dist) {
  const keys = Object.keys(dist);
  let tot = 0;
  for (const k of keys) tot += dist[k];
  let r = rand() * tot;
  for (const k of keys) { r -= dist[k]; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

// ---------------- reference data ----------------
const ncrb = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'ncrb_states_2023.json'), 'utf8'));
const tax = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'ncrb_crime_heads_2022.json'), 'utf8'));
const districtRef = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'india_districts_full.json'), 'utf8'));
const localityPath = path.join(REF_DIR, 'india_localities.json');
if (!fs.existsSync(localityPath)) {
  console.error('Missing ref/india_localities.json. Run:  ./datastore/fetch-geo.sh && node datastore/build-geo.js');
  process.exit(1);
}
const localityRef = JSON.parse(fs.readFileSync(localityPath, 'utf8'));

const stateHeadsRef = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'ncrb_state_heads_2022.json'), 'utf8'));
const STATE_HEADS = stateHeadsRef.states;
const STATE_CAL = new Map(ncrb.states.map((s) => [s.state, s]));

// ---------------- geography ----------------
// Post-office class is the best available proxy for how much population a locality
// serves: head offices sit in town centres, branch offices are village-level.
const KIND_WEIGHT = { 'H.O': 6, 'G.P.O': 8, 'S.O': 3, 'B.O': 1 };

const DISTRICTS = districtRef
  .filter((d) => STATE_CAL.has(d.state))
  .map((d) => {
    const raw = localityRef[d.code] || [];
    const locs = raw.map(([name, taluk, pin, lat, lng, kind]) => ({
      name, taluk: taluk || d.district, pin, lat, lng, w: KIND_WEIGHT[kind] || 1,
    }));
    const wTotal = locs.reduce((a, l) => a + l.w, 0);
    const taluks = [...new Set(locs.map((l) => l.taluk))];
    return {
      code: d.code, state: d.state, district: d.district, pop: d.pop2011,
      lat: d.lat, lng: d.lng, bbox: d.bbox, demo: d.demo, locs, wTotal, taluks,
    };
  })
  .filter((d) => d.locs.length > 0);

// Police stations are named after the taluks actually present in the district, which
// is how station geography works on the ground. Taluk names repeat across districts —
// there are Lalganj taluks in a dozen Uttar Pradesh districts — so the station name
// carries the district wherever the taluk alone would be ambiguous nationally. Without
// this, 2,808 station names spanned more than one district and any grouping by station
// silently merged unrelated stations.
{
  const talukDistricts = new Map();
  const districtStates = new Map();
  for (const d of DISTRICTS) {
    if (!districtStates.has(d.district)) districtStates.set(d.district, new Set());
    districtStates.get(d.district).add(d.state);
    for (const t of d.taluks) {
      if (!talukDistricts.has(t)) talukDistricts.set(t, new Set());
      talukDistricts.get(t).add(d.district + '|' + d.state);
    }
  }
  for (const d of DISTRICTS) {
    d.stations = new Map();
    // Six district names are themselves shared across states — Aurangabad, Bilaspur,
    // Hamirpur, Pratapgarh, Raigarh, Bijapur — so qualifying by district alone is not
    // always enough.
    const qualifier = districtStates.get(d.district).size > 1
      ? `${d.district}, ${d.state}` : d.district;
    for (const t of d.taluks) {
      const ambiguous = talukDistricts.get(t).size > 1 || t === d.district;
      d.stations.set(t, ambiguous ? `${t} PS, ${qualifier}` : `${t} PS`);
    }
  }
}

// Volume model: a state's total is the sum of its own real per-head case counts, so
// volume and crime mix come from the same reconciled table rather than one from the
// 2023 summary and the other from the 2022 head tables. Within a state, districts split
// that total by population weighted by urban share — urban districts register
// materially more crime per head, which NCRB's separate metropolitan tables show.
const STATE_VOLUME = new Map(Object.entries(STATE_HEADS)
  .map(([st, heads]) => [st, Object.values(heads).reduce((a, b) => a + b, 0)]));
const stateWeight = new Map();
for (const d of DISTRICTS) {
  d.weight = d.pop * (0.75 + 0.6 * Math.min(1, d.demo.urbanShare));
  stateWeight.set(d.state, (stateWeight.get(d.state) || 0) + d.weight);
}
for (const d of DISTRICTS) {
  d.intensity = (STATE_VOLUME.get(d.state) || 0) * (d.weight / stateWeight.get(d.state));
}
const TOTAL_INTENSITY = DISTRICTS.reduce((a, d) => a + d.intensity, 0);

// ---------------- crime taxonomy ----------------
const HEADS = tax.heads.map((h) => {
  const g = tax.groups[h.group];
  return {
    head: h.head, group: h.group, law: h.law, gravity: h.gravity,
    cases: h.cases2022, dryOnly: !!h.dryStateOnly,
    rho: g.branching, delay: g.delayDays, sigma: g.sigmaDeg,
  };
});
const HEAD_TOTAL = HEADS.reduce((a, h) => a + h.cases, 0);
// Detection varies enormously by offence — a murder is almost always traced, a
// street theft usually is not — and the state chargesheet rate is a single average.
// These multipliers redistribute detection across groups; they are renormalised per
// state below so each state's aggregate chargesheet rate still matches NCRB exactly.
// Without this, "which crimes go unsolved" is a flat line, which is plainly wrong.
const DETECTION_MULTIPLIER = {
  'Body Offences': 1.20,
  'Crime Against Women': 1.15,
  'Crime Against Children': 1.10,
  'Kidnapping & Trafficking': 0.95,
  'Property Offences': 0.55,
  'Economic Offences': 0.70,
  'Cyber Crime': 0.45,
  'Narcotics': 1.30,
  'Liquor & Excise': 1.35,
  'Public Order': 1.10,
  'Traffic & Negligence': 1.05,
  'Caste Atrocities': 1.00,
  'Arms & Explosives': 1.30,
  'Offences Against the State': 1.00,
  'Environment & Wildlife': 1.25,
  'Regulatory & Local Acts': 1.30,
};

// Seasonality: festival (Oct-Dec) and summer (Mar-May) peaks; weekend elevation.
const MONTH_MULT = [0.90, 0.88, 1.05, 1.12, 1.15, 0.98, 0.95, 0.97, 1.08, 1.28, 1.35, 1.20];
const DOW_MULT = [0.95, 0.98, 1.00, 1.02, 1.08, 1.20, 1.12];
const DAY = 86400000;
const END = Date.UTC(2026, 6, 1);
const START = END - Math.round(YEARS_SPAN * 365.25 * DAY);
const trendAt = (t) => 1.04 - 0.08 * ((t - START) / (END - START));
const envelope = (t) => {
  const d = new Date(t);
  return MONTH_MULT[d.getUTCMonth()] * DOW_MULT[d.getUTCDay()] * trendAt(t);
};
const MAXENV = 1.35 * 1.20 * 1.04;

module.exports = { DISTRICTS, HEADS };

// ---------------- names (regionally varied) ----------------
// List sizes matter, not just their contents: the pool of distinct offenders in a
// large state runs to five figures, and given x father x surname must exceed that or
// separate offenders merge into one identity. Roughly 45 given names and 30 surnames
// per region yields around 60,000 combinations, which clears the requirement.
const FIRST_N = ['Amit', 'Rajesh', 'Sunil', 'Vikram', 'Anil', 'Deepak', 'Rohit', 'Sanjay', 'Pooja',
  'Neha', 'Kavita', 'Sunita', 'Priya', 'Aarti', 'Manoj', 'Ashok', 'Rekha', 'Seema', 'Ramesh',
  'Dinesh', 'Mukesh', 'Rakesh', 'Naresh', 'Shyam', 'Mohan', 'Gopal', 'Devendra', 'Jitendra',
  'Satyendra', 'Brijesh', 'Kamlesh', 'Umesh', 'Yogesh', 'Pankaj', 'Vinod', 'Arun', 'Ravindra',
  'Shivam', 'Abhishek', 'Saurabh', 'Nitesh', 'Bhupendra', 'Meena', 'Anjali', 'Sarita', 'Usha',
  'Poonam', 'Kiran', 'Lalita', 'Shanti'];
const FIRST_S = ['Ravi', 'Suresh', 'Manjunath', 'Prakash', 'Karthik', 'Venkatesh', 'Lakshmi',
  'Anitha', 'Divya', 'Meena', 'Shivakumar', 'Nagaraj', 'Srinivas', 'Padma', 'Vijaya', 'Basavaraj',
  'Mallikarjun', 'Chandrashekar', 'Krishnappa', 'Rangaswamy', 'Govindaraju', 'Thimmaiah',
  'Siddappa', 'Nanjundaswamy', 'Ramachandra', 'Subramani', 'Murugan', 'Selvam', 'Arumugam',
  'Perumal', 'Rajendran', 'Balakrishnan', 'Sundaram', 'Ganesan', 'Vasanth', 'Hariprasad',
  'Sathish', 'Dhanalakshmi', 'Kalpana', 'Saraswathi', 'Bhavani', 'Geetha', 'Radha', 'Shobha',
  'Mangala', 'Yashoda', 'Sridevi', 'Kavitha'];
const FIRST_E = ['Subrata', 'Debasish', 'Tapan', 'Biswajit', 'Ranjan', 'Sourav', 'Mousumi', 'Sikha',
  'Rupali', 'Ananya', 'Pradip', 'Jyotsna', 'Sanjib', 'Ashis', 'Prasenjit', 'Sukumar', 'Nirmal',
  'Gautam', 'Bikash', 'Chandan', 'Dipankar', 'Kartik', 'Manas', 'Nabin', 'Palash', 'Rabindra',
  'Sailen', 'Tarun', 'Uttam', 'Bimal', 'Jagannath', 'Sitaram', 'Bhagirathi', 'Rasmita',
  'Sasmita', 'Puspanjali', 'Sabita', 'Namita', 'Aparna', 'Chaitali', 'Debjani', 'Kakoli',
  'Moumita', 'Piyali', 'Sanjukta', 'Tapasi'];
const FIRST_W = ['Nitin', 'Mahesh', 'Pravin', 'Sachin', 'Jignesh', 'Bhavesh', 'Snehal', 'Vaishali',
  'Trupti', 'Manisha', 'Kiran', 'Nilesh', 'Sandip', 'Sunil', 'Prashant', 'Amol', 'Yogesh',
  'Nandkumar', 'Bhaskar', 'Dattatray', 'Ganpat', 'Hemant', 'Kishor', 'Laxman', 'Madhukar',
  'Namdev', 'Pandurang', 'Ramdas', 'Shankar', 'Tukaram', 'Vasant', 'Vithal', 'Dilip', 'Hitesh',
  'Ketan', 'Paresh', 'Rakeshbhai', 'Chetna', 'Jyoti', 'Kalpesh', 'Nirmala', 'Rohini', 'Sangita',
  'Shubhangi', 'Smita', 'Ujwala', 'Varsha'];
const FIRST_NE = ['Bikash', 'Lalrin', 'Temjen', 'Neiphiu', 'Thangboi', 'Mary', 'Esther', 'Rinchen',
  'Karma', 'Pema', 'Dhruba', 'Jiten', 'Nabakumar', 'Ibomcha', 'Tomba', 'Chaoba', 'Lalthanzara',
  'Zoramthanga', 'Vanlalruata', 'Imkong', 'Along', 'Kevi', 'Vikho', 'Wangsu', 'Tashi', 'Sonam',
  'Dorjee', 'Nima', 'Bipul', 'Dhiren', 'Hemanta', 'Jogen', 'Kamal', 'Nripen', 'Pranab', 'Rupam',
  'Sanjib', 'Utpal', 'Anima', 'Binita', 'Deepali', 'Junu', 'Momi', 'Purnima', 'Rekha', 'Tarali'];
const LAST_N = ['Sharma', 'Verma', 'Yadav', 'Singh', 'Gupta', 'Mishra', 'Tiwari', 'Chauhan',
  'Pandey', 'Rathore', 'Saini', 'Kashyap', 'Dubey', 'Shukla', 'Trivedi', 'Bhardwaj', 'Agarwal',
  'Goel', 'Jaiswal', 'Kushwaha', 'Maurya', 'Nishad', 'Prajapati', 'Rajput', 'Sahu', 'Solanki',
  'Thakur', 'Tomar', 'Chaudhary', 'Dhaka', 'Meena', 'Bairwa', 'Jat', 'Gurjar', 'Sisodia'];
const LAST_S = ['Gowda', 'Shetty', 'Rao', 'Reddy', 'Naidu', 'Iyer', 'Nair', 'Menon', 'Murthy',
  'Pillai', 'Hegde', 'Achari', 'Kulkarni', 'Patil', 'Bhat', 'Rai', 'Poojary', 'Devadiga',
  'Nayak', 'Shastri', 'Varma', 'Chetty', 'Mudaliar', 'Pandian', 'Thevar', 'Gounder', 'Nadar',
  'Kurup', 'Panicker', 'Namboothiri', 'Warrier', 'Sharma', 'Prabhu', 'Kamath', 'Pai'];
const LAST_E = ['Das', 'Ghosh', 'Banerjee', 'Chatterjee', 'Mondal', 'Sarkar', 'Bose', 'Mahato',
  'Pradhan', 'Nayak', 'Mohanty', 'Patra', 'Behera', 'Jena', 'Rout', 'Swain', 'Panda', 'Mishra',
  'Dutta', 'Roy', 'Sen', 'Biswas', 'Halder', 'Pal', 'Bhowmik', 'Kumar', 'Prasad', 'Singh',
  'Ram', 'Paswan', 'Manjhi', 'Oraon', 'Munda', 'Soren', 'Tudu'];
const LAST_W = ['Patil', 'Desai', 'Joshi', 'Kulkarni', 'Shah', 'Patel', 'Jadhav', 'More',
  'Deshmukh', 'Chavan', 'Pawar', 'Shinde', 'Gaikwad', 'Kadam', 'Sawant', 'Bhosale', 'Salunkhe',
  'Thorat', 'Wagh', 'Mane', 'Solanki', 'Vaghela', 'Chaudhari', 'Rathod', 'Parmar', 'Makwana',
  'Trivedi', 'Mehta', 'Modi', 'Bhatt', 'Sharma', 'Jain', 'Soni', 'Panchal', 'Prajapati'];
const LAST_NE = ['Hazarika', 'Borah', 'Sangma', 'Marak', 'Ao', 'Konyak', 'Chakma', 'Bhutia',
  'Lepcha', 'Ralte', 'Saikia', 'Bora', 'Das', 'Deka', 'Kalita', 'Nath', 'Gogoi', 'Dutta',
  'Baruah', 'Bezbaruah', 'Sharma', 'Rabha', 'Boro', 'Basumatary', 'Brahma', 'Narzary', 'Syiem',
  'Lyngdoh', 'Kharkongor', 'Singh', 'Devi', 'Meitei', 'Zoliana', 'Hmar', 'Tamang'];
const LAST_MUSLIM = ['Khan', 'Sheikh', 'Ansari', 'Qureshi', 'Siddiqui', 'Pathan', 'Mirza',
  'Hussain', 'Rahman', 'Beg', 'Ahmed', 'Ali', 'Alam', 'Farooqui', 'Hashmi', 'Idrisi', 'Jafri',
  'Khatun', 'Malik', 'Mansuri', 'Momin', 'Nadvi', 'Rizvi', 'Saifi', 'Shaikh', 'Syed', 'Usmani',
  'Zaidi', 'Chishti', 'Deshmukh', 'Kazi', 'Memon', 'Patel', 'Sayyed', 'Tamboli'];
const FIRST_MUSLIM = ['Imran', 'Faisal', 'Aslam', 'Rizwan', 'Sameer', 'Nasir', 'Farhana', 'Ayesha',
  'Nazia', 'Shabana', 'Abdul', 'Mohammed', 'Iqbal', 'Javed', 'Kamruddin', 'Mustafa', 'Naeem',
  'Parvez', 'Rafiq', 'Salim', 'Shahid', 'Tariq', 'Wasim', 'Yusuf', 'Zahir', 'Anwar', 'Bashir',
  'Firoz', 'Hamid', 'Irfan', 'Junaid', 'Khalid', 'Lateef', 'Nadeem', 'Rehana', 'Sabina',
  'Tabassum', 'Zainab', 'Fatima', 'Hasina', 'Noorjahan', 'Ruksana', 'Shaheen', 'Yasmin'];
const LAST_CHRISTIAN = ['Fernandes', 'D\'Souza', 'Pereira', 'Thomas', 'Mathew', 'Lobo',
  'Rodrigues', 'Gomes', 'Dias', 'Pinto', 'Correa', 'Menezes', 'Nazareth', 'Sequeira', 'Vaz',
  'Abraham', 'Chacko', 'George', 'Jacob', 'John', 'Joseph', 'Kurien', 'Philip', 'Samuel',
  'Varghese', 'Zachariah', 'Massey', 'Peter', 'Paul', 'Michael', 'Francis', 'Anthony',
  'Baptista', 'Coelho', 'Monteiro'];
const FIRST_CHRISTIAN = ['Joseph', 'Anthony', 'Rosy', 'Maria', 'Jacob', 'Clara', 'Francis',
  'Agnes', 'Albert', 'Benny', 'Cyril', 'Daniel', 'Edwin', 'Felix', 'Gregory', 'Henry', 'Ivan',
  'James', 'Kevin', 'Lawrence', 'Martin', 'Nelson', 'Oliver', 'Patrick', 'Robert', 'Stephen',
  'Thomas', 'Vincent', 'Wilson', 'Xavier', 'Alice', 'Beena', 'Celine', 'Dolly', 'Elizabeth',
  'Flora', 'Gracy', 'Helen', 'Irene', 'Jessy', 'Lilly', 'Molly', 'Nancy', 'Reena', 'Sheela'];
const LAST_SIKH = ['Singh', 'Kaur', 'Gill', 'Sandhu', 'Dhillon', 'Bedi', 'Grewal', 'Sidhu',
  'Bajwa', 'Brar', 'Chahal', 'Dhaliwal', 'Gandhi', 'Hundal', 'Kalsi', 'Khera', 'Lally', 'Mann',
  'Nagra', 'Randhawa', 'Sahota', 'Sekhon', 'Sohal', 'Toor', 'Virk', 'Aujla', 'Bhullar', 'Cheema',
  'Deol', 'Ghuman', 'Kang', 'Lubana', 'Nijjar', 'Panesar', 'Rai'];
const FIRST_SIKH = ['Gurpreet', 'Harjit', 'Jaswinder', 'Manpreet', 'Simranjit', 'Baljit',
  'Amarjit', 'Balwinder', 'Charanjit', 'Darshan', 'Gurdeep', 'Harbhajan', 'Inderjit', 'Jagtar',
  'Kulwant', 'Lakhwinder', 'Mohinder', 'Narinder', 'Paramjit', 'Rajinder', 'Sukhwinder',
  'Tarlochan', 'Avtar', 'Bhupinder', 'Davinder', 'Gurmeet', 'Hardeep', 'Jasbir', 'Kuldeep',
  'Malkiat', 'Navjot', 'Pargat', 'Ranjit', 'Satnam', 'Surinder', 'Tejinder', 'Amandeep',
  'Harpreet', 'Jaspreet', 'Kirandeep', 'Manjit', 'Rupinder', 'Sarbjit', 'Veerpal'];

// The lists above are mixed-gender. Splitting them matters twice over: a female
// victim named Rajesh is an obvious defect, and the father's-name slot must be male
// or records read as nonsense ("Shivam Seema Nishad").
const FEMALE_NAMES = new Set(['Pooja', 'Neha', 'Kavita', 'Sunita', 'Priya', 'Aarti', 'Rekha', 'Seema',
  'Meena', 'Anjali', 'Sarita', 'Usha', 'Poonam', 'Kiran', 'Lalita', 'Shanti', 'Lakshmi', 'Anitha',
  'Divya', 'Padma', 'Vijaya', 'Dhanalakshmi', 'Kalpana', 'Saraswathi', 'Bhavani', 'Geetha', 'Radha',
  'Shobha', 'Mangala', 'Yashoda', 'Sridevi', 'Kavitha', 'Mousumi', 'Sikha', 'Rupali', 'Ananya',
  'Jyotsna', 'Bhagirathi', 'Rasmita', 'Sasmita', 'Puspanjali', 'Sabita', 'Namita', 'Aparna',
  'Chaitali', 'Debjani', 'Kakoli', 'Moumita', 'Piyali', 'Sanjukta', 'Tapasi', 'Snehal', 'Vaishali',
  'Trupti', 'Manisha', 'Chetna', 'Jyoti', 'Nirmala', 'Rohini', 'Sangita', 'Shubhangi', 'Smita',
  'Ujwala', 'Varsha', 'Mary', 'Esther', 'Anima', 'Binita', 'Deepali', 'Junu', 'Momi', 'Purnima',
  'Tarali', 'Farhana', 'Ayesha', 'Nazia', 'Shabana', 'Rehana', 'Sabina', 'Tabassum', 'Zainab',
  'Fatima', 'Hasina', 'Noorjahan', 'Ruksana', 'Shaheen', 'Yasmin', 'Rosy', 'Maria', 'Clara',
  'Agnes', 'Alice', 'Beena', 'Celine', 'Dolly', 'Elizabeth', 'Flora', 'Gracy', 'Helen', 'Irene',
  'Jessy', 'Lilly', 'Molly', 'Nancy', 'Reena', 'Sheela', 'Amandeep', 'Harpreet', 'Jaspreet',
  'Kirandeep', 'Rupinder', 'Sarbjit', 'Veerpal', 'Simranjit']);
const males = (a) => a.filter((n) => !FEMALE_NAMES.has(n));
const females = (a) => a.filter((n) => FEMALE_NAMES.has(n));
/** [maleGiven, femaleGiven, surname] — the father's name is always drawn from maleGiven. */
const zone = (first, last) => [males(first), females(first), last];
const NAME_ZONES = {
  north: zone(FIRST_N, LAST_N), south: zone(FIRST_S, LAST_S), east: zone(FIRST_E, LAST_E),
  west: zone(FIRST_W, LAST_W), northeast: zone(FIRST_NE, LAST_NE),
};
const NAME_RELIGION = {
  Muslim: zone(FIRST_MUSLIM, LAST_MUSLIM),
  Christian: zone(FIRST_CHRISTIAN, LAST_CHRISTIAN),
  Sikh: zone(FIRST_SIKH, LAST_SIKH),
};
const STATE_ZONE = {
  'Kerala': 'south', 'Tamil Nadu': 'south', 'Karnataka': 'south', 'Andhra Pradesh': 'south',
  'Telangana': 'south', 'Puducherry': 'south', 'Lakshadweep': 'south',
  'West Bengal': 'east', 'Odisha': 'east', 'Bihar': 'east', 'Jharkhand': 'east',
  'Andaman and Nicobar Islands': 'east',
  'Assam': 'northeast', 'Tripura': 'northeast', 'Meghalaya': 'northeast', 'Manipur': 'northeast',
  'Mizoram': 'northeast', 'Nagaland': 'northeast', 'Arunachal Pradesh': 'northeast', 'Sikkim': 'northeast',
  'Maharashtra': 'west', 'Gujarat': 'west', 'Goa': 'west', 'Rajasthan': 'west',
  'Dadra and Nagar Haveli and Daman and Diu': 'west',
};
/**
 * Name generation follows the district's real religious composition.
 *
 * The middle element is the father's given name, which is how a large part of India
 * actually names people and, incidentally, is what makes the name space big enough
 * to be useful here: given x father x surname yields tens of thousands of distinct
 * identities per region. With only given x surname, a hundred thousand simulated
 * offenders collapsed onto a few hundred names, which left the offender-risk table
 * and the co-offending graph meaningless.
 */
function nameFor(d, religion, gender) {
  const rel = religion || weightedKey(d.demo.religion);
  const [M, F, L] = NAME_RELIGION[rel] || NAME_ZONES[STATE_ZONE[d.state] || 'north'];
  const given = (gender === 'F' && F.length) ? pick(F) : pick(M);
  return given + ' ' + pick(M) + ' ' + pick(L);
}

// Weighted, not uniform: an even draw inside the cultivator bucket made orchard owners
// as common as farmers, and the non-worker occupations were missing entirely, so every
// complainant in the data was employed. Census worker share is around 40%, so most
// adults are homemakers, students, retired or unemployed.
const OCC_BY_CLASS = {
  Cultivator: { Farmer: 0.62, Cultivator: 0.33, 'Orchard Owner': 0.05 },
  'Agricultural Labourer': { 'Agricultural Labourer': 0.5, 'Daily Wage Labourer': 0.38, 'Farm Hand': 0.12 },
  'Household Industry': { Tailor: 0.3, Weaver: 0.22, Artisan: 0.2, Potter: 0.14, 'Handloom Worker': 0.14 },
  Other: {
    Business: 0.13, Shopkeeper: 0.12, Driver: 0.11, 'Construction Worker': 0.11,
    'Factory Worker': 0.10, 'Govt Employee': 0.07, Teacher: 0.06, Mechanic: 0.05,
    'Security Guard': 0.05, Clerk: 0.04, Electrician: 0.04, 'Delivery Rider': 0.04,
    Contractor: 0.03, 'IT Professional': 0.03, Nurse: 0.01, 'Bank Employee': 0.01,
  },
};
const NON_WORKER = { Homemaker: 0.46, Student: 0.24, Unemployed: 0.18, Retired: 0.12 };
const NON_WORKER_FEMALE = { Homemaker: 0.72, Student: 0.15, Unemployed: 0.08, Retired: 0.05 };
// Groups with no individual victim: liquor and excise, drug possession, gambling and
// most regulatory offences are enforcement actions, not offences against a person.
const VICTIMLESS = new Set(['Liquor & Excise', 'Narcotics', 'Regulatory & Local Acts',
  'Environment & Wildlife', 'Arms & Explosives', 'Offences Against the State']);
const CASTE_GENERAL = { General: 0.28, OBC: 0.72 };
// Scheduled Caste status is confined by Presidential Order to Hindus, Sikhs and
// Buddhists; Scheduled Tribe status is not religion-restricted. Drawing caste
// independently of religion produced 51,722 complainants recorded as Muslim SC,
// Christian SC and Jain SC — combinations that cannot legally exist.
const SC_ELIGIBLE = new Set(['Hindu', 'Sikh', 'Buddhist']);

/** Draw a person's social attributes from this district's census distributions. */
function personDemo(d) {
  const religion = weightedKey(d.demo.religion);
  const scOk = SC_ELIGIBLE.has(religion);
  const sc = scOk ? d.demo.scShare : 0;
  const r = rand() * (sc + d.demo.stShare + (1 - d.demo.scShare - d.demo.stShare));
  let caste;
  if (r < sc) caste = 'SC';
  else if (r < sc + d.demo.stShare) caste = 'ST';
  else caste = weightedKey(CASTE_GENERAL);
  const occClass = weightedKey(d.demo.occupation);
  return { religion, caste, occClass };
}
/** Adult age drawn from the district's real age bands. */
function adultAge(d) {
  const a = d.demo.age;
  const r = rand() * (a.a0_29 * 0.42 + a.a30_49 + a.a50); // only the adult part of 0-29
  if (r < a.a0_29 * 0.42) return randint(18, 29);
  if (r < a.a0_29 * 0.42 + a.a30_49) return randint(30, 49);
  return randint(50, 82);
}
/**
 * Occupation consistent with the district's worker share and the person's gender.
 * Census worker share counts workers against the whole population, children included,
 * and hides an enormous gender gap: male work participation runs around 80% of adults,
 * female around 30-35%. Applying the headline share to both sexes left homemakers at
 * 5% of complainants when they should be closer to a fifth.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function occupationFor(d, gender, age) {
  if (age >= 62 && chance(0.45)) return 'Retired';
  const pWorker = gender === 'F'
    ? clamp(d.demo.workerShare * 0.95, 0.15, 0.55)
    : clamp(d.demo.workerShare * 2.0, 0.60, 0.95);
  if (rand() > pWorker) return weightedKey(gender === 'F' ? NON_WORKER_FEMALE : NON_WORKER);
  return weightedKey(OCC_BY_CLASS[weightedKey(d.demo.occupation)]);
}
/**
 * Accused age. A flat 18-58 draw misrepresented offending, which concentrates in the
 * late teens to early thirties, and excluded juveniles entirely even though the data
 * carries Juvenile Justice Act cases.
 */
function accusedAge() {
  const r = rand();
  if (r < 0.03) return randint(14, 17);
  if (r < 0.27) return randint(18, 24);
  if (r < 0.58) return randint(25, 34);
  if (r < 0.80) return randint(35, 44);
  if (r < 0.95) return randint(45, 59);
  return randint(60, 76);
}

const pad = (n, w) => String(n).padStart(w, '0');
const CAT_CODE = { FIR: 1, UDR: 3, PAR: 4, 'Zero FIR': 8 };

// ---------------- streaming CSV writer ----------------
// Rows are appended as they are produced so a multi-million-row run never holds a
// whole table in memory.
function csvWriter(dir, name, cols) {
  const file = path.join(dir, name + '.csv');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, cols.join(',') + '\n');
  let buf = '', n = 0;
  const esc = (v) => {
    if (v === null || v === undefined) v = '';
    v = String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return {
    write(row) {
      let line = '';
      for (let i = 0; i < cols.length; i++) line += (i ? ',' : '') + esc(row[cols[i]]);
      buf += line + '\n'; n++;
      if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
    },
    close() {
      if (buf) fs.writeSync(fd, buf);
      fs.closeSync(fd);
      console.log(`  ${name}.csv  ->  ${n.toLocaleString('en-IN')} rows`);
      return n;
    },
    get count() { return n; },
  };
}

// ---------------- ETAS simulation ----------------
// Seeding each head at its target share would overshoot, because the cascade
// multiplies every head by its own branching factor. The correction is exact rather
// than approximate. With target shares s, branching rho, and probability RETAIN that
// an offspring repeats its parent's head (otherwise redrawn from s), the observed
// counts n satisfy
//     n_k = f_k + RETAIN * rho_k * n_k + (1 - RETAIN) * s_k * SUM_h(rho_h * n_h)
// Solving for the background f that yields n proportional to s gives
//     f_k = s_k * ( 1 - RETAIN * rho_k - (1 - RETAIN) * rhoBar )
// and the total inflates by 1 / (1 - rhoBar). Deriving it this way is what makes the
// generated head mix land on the NCRB shares instead of near them; the previous
// (1 - rho) approximation under-produced high-branching heads such as the
// Prohibition Act by about a third.
const RETAIN = 0.85;
const stateHeadWeights = new Map();
for (const st of new Set(DISTRICTS.map((d) => d.state))) {
  const cal = STATE_CAL.get(st);
  const real = STATE_HEADS[st] || {};
  const vol = STATE_VOLUME.get(st) || 1;
  // Each head's target share in this state is that state's own published count.
  // Nothing is modelled: no national mix, no per-rate tilt, no hand-allocated
  // prohibition. A head the state did not register gets zero.
  const target = HEADS.map((h) => (real[h.head] || 0) / vol);
  const rhoBar = HEADS.reduce((a, h, i) => a + target[i] * h.rho, 0);
  const bg = HEADS.map((h, i) =>
    Math.max(0, target[i] * (1 - RETAIN * h.rho - (1 - RETAIN) * rhoBar)));
  // Per-group detection probability, rescaled so this state's aggregate still equals
  // its real chargesheet rate.
  const meanMult = HEADS.reduce((a, h, i) => a + target[i] * (DETECTION_MULTIPLIER[h.group] || 1), 0) || 1;
  const detect = HEADS.map((h) =>
    Math.min(0.99, (cal.chargesheetRate / 100) * (DETECTION_MULTIPLIER[h.group] || 1) / meanMult));
  stateHeadWeights.set(st, { bg, bgTot: bg.reduce((a, b) => a + b, 0), target, rhoBar, detect });
}
// National expected inflation from background to total.
const NATIONAL_RHOBAR = (() => {
  let num = 0, den = 0;
  for (const d of DISTRICTS) {
    num += d.intensity * stateHeadWeights.get(d.state).rhoBar;
    den += d.intensity;
  }
  return num / den;
})();

// Background is scaled so that after the cascade inflates it by 1/(1 - rhoBar) the
// run lands on the requested case count.
const SCALE = (TARGET_CASES * (1 - NATIONAL_RHOBAR)) / (TOTAL_INTENSITY * YEARS_SPAN);

console.log('All-India ETAS simulation');
console.log(`  districts=${DISTRICTS.length}  states/UTs=${new Set(DISTRICTS.map((d) => d.state)).size}` +
  `  localities=${DISTRICTS.reduce((a, d) => a + d.locs.length, 0).toLocaleString('en-IN')}` +
  `  crime heads=${HEADS.length}`);
console.log(`  window=${new Date(START).toISOString().slice(0, 10)} .. ${new Date(END).toISOString().slice(0, 10)} (${YEARS_SPAN}y)`);
console.log(`  real all-India volume=${Math.round(TOTAL_INTENSITY).toLocaleString('en-IN')} cases/yr` +
  ` -> target=${TARGET_CASES.toLocaleString('en-IN')} over ${YEARS_SPAN}y (scale=${(SCALE * 100).toFixed(3)}%)`);
console.log(`  mean branching ratio=${NATIONAL_RHOBAR.toFixed(3)} -> cascade inflation ${(1 / (1 - NATIONAL_RHOBAR)).toFixed(2)}x`);

// Events are kept in parallel typed arrays: at multi-million scale an array of
// objects would cost several GB.
let cap = Math.max(1 << 16, Math.ceil(TARGET_CASES * 1.4));
let evT = new Float64Array(cap), evLat = new Float32Array(cap), evLng = new Float32Array(cap);
let evDi = new Int32Array(cap), evHi = new Int16Array(cap), evLoc = new Int32Array(cap);
let evN = 0;
function grow() {
  const nc = Math.ceil(cap * 1.6);
  const g = (Old, T) => { const a = new T(nc); a.set(Old); return a; };
  evT = g(evT, Float64Array); evLat = g(evLat, Float32Array); evLng = g(evLng, Float32Array);
  evDi = g(evDi, Int32Array); evHi = g(evHi, Int16Array); evLoc = g(evLoc, Int32Array);
  cap = nc;
}
function pushEvent(t, di, hi, lat, lng, loc) {
  if (evN === cap) grow();
  evT[evN] = t; evDi[evN] = di; evHi[evN] = hi; evLat[evN] = lat; evLng[evN] = lng; evLoc[evN] = loc;
  evN++;
}

// -- background: real localities, so incidents sit where people actually live
for (let di = 0; di < DISTRICTS.length; di++) {
  const d = DISTRICTS[di];
  const { bg, bgTot } = stateHeadWeights.get(d.state);
  const expected = d.intensity * YEARS_SPAN * SCALE;
  const locW = d.locs.map((l) => l.w);
  for (let hi = 0; hi < HEADS.length; hi++) {
    if (bg[hi] === 0) continue;
    const n = poisson(expected * (bg[hi] / bgTot));
    for (let k = 0; k < n; k++) {
      let t;
      do { t = START + rand() * (END - START); } while (rand() > envelope(t) / MAXENV);
      const li = weightedIndex(locW, d.wTotal);
      const loc = d.locs[li];
      // ~400 m scatter around the locality centre.
      pushEvent(t, di, hi, loc.lat + gauss(0, 0.004), loc.lng + gauss(0, 0.004), li);
    }
  }
}
const bgCount = evN;

// -- self-excitation cascade (near-repeat victimisation and retaliation)
for (let cursor = 0; cursor < evN; cursor++) {
  const h = HEADS[evHi[cursor]];
  const kids = poisson(h.rho);
  if (!kids) continue;
  const pt = evT[cursor], pdi = evDi[cursor], plat = evLat[cursor], plng = evLng[cursor], ploc = evLoc[cursor];
  const { target } = stateHeadWeights.get(DISTRICTS[pdi].state);
  for (let j = 0; j < kids; j++) {
    const t = pt - h.delay * DAY * Math.log(Math.max(rand(), 1e-9));
    if (t >= END) continue;
    // Most offspring repeat the parent offence; the rest are redrawn from the local
    // target mix, which is the distribution the correction above assumes.
    const hi = chance(RETAIN) ? evHi[cursor] : weightedIndex(target, 1);
    pushEvent(t, pdi, hi, plat + gauss(0, h.sigma), plng + gauss(0, h.sigma), ploc);
  }
}
console.log(`  background=${bgCount.toLocaleString('en-IN')}  total=${evN.toLocaleString('en-IN')}` +
  `  near-repeat=${((1 - bgCount / evN) * 100).toFixed(1)}%`);

// Sort by time via an index permutation — sorting 5 parallel arrays directly would
// need a full custom sort, and the permutation is cheaper and clearer.
console.log('  sorting events by time…');
const order = new Int32Array(evN);
for (let i = 0; i < evN; i++) order[i] = i;
{
  const idx = Array.from(order);
  idx.sort((a, b) => evT[a] - evT[b]);
  for (let i = 0; i < evN; i++) order[i] = idx[i];
}

// ---------------- offenders & organised rings ----------------
// Share of accused slots filled from the known-offender pool rather than by a person
// appearing for the first time. NCRB puts recidivism among arrested persons in the
// high single digits; drawing from a Zipf-weighted pool at this rate reproduces a
// comparable repeat-offender profile without flattening it.
const REPEAT_SHARE = 0.30;
// Offender pools are per-state so co-offending networks stay geographically coherent.
const statesList = [...new Set(DISTRICTS.map((d) => d.state))];
const stateEventCount = new Map();
for (let i = 0; i < evN; i++) {
  const st = DISTRICTS[evDi[i]].state;
  stateEventCount.set(st, (stateEventCount.get(st) || 0) + 1);
}
const offendersByState = {};
const poolWeightByState = {};
const ringsByState = {};
let ringSeq = 0;
for (const st of statesList) {
  const stDistricts = DISTRICTS.filter((d) => d.state === st);
  const stEvents = stateEventCount.get(st) || 0;
  const nOff = Math.max(40, Math.round(stEvents * 0.09));
  // Distinct identities are enforced rather than hoped for: a duplicate in the pool
  // would silently merge two offenders' histories in the risk table and graph.
  const distWeights = stDistricts.map((x) => x.weight);
  const seen = new Set();
  const pool = [];
  const poolW = [];
  for (let guard = 0; pool.length < nOff && guard < nOff * 12; guard++) {
    const d = stDistricts[weightedIndex(distWeights)];
    const gender = chance(0.91) ? 'M' : 'F';
    const name = nameFor(d, null, gender);
    if (seen.has(name)) continue;
    seen.add(name);
    pool.push({ name, ring: 0, age: randint(18, 58), gender, known: true });
    // Log-normal activity weight. Drawing uniformly gave every repeat offender
    // roughly the same case count, which is not how offending is distributed. A Zipf
    // weight overcorrected hard — rank-one offenders took several per cent of a whole
    // state's draws and ended up with thousands of cases. Log-normal gives most
    // offenders a similar load with a plausible tail of a few times the median.
    poolW.push(Math.exp(gauss(0, 0.55)));
  }
  offendersByState[st] = pool;
  poolWeightByState[st] = { w: poolW, tot: poolW.reduce((a, b) => a + b, 0) };
  const nRings = Math.max(1, Math.min(24, Math.round(stEvents / 4000)));
  const rings = [];
  for (let r = 0; r < nRings; r++) {
    ringSeq += 1;
    // Distinct members: allowing repeats meant a person listed twice in the array was
    // drawn twice as often, which pushed a handful of offenders past 250 cases.
    const memberSet = new Set();
    const size = randint(6, 18);
    for (let m = 0; m < size * 3 && memberSet.size < size; m++) memberSet.add(pick(pool));
    const members = [...memberSet];
    for (const o of members) o.ring = ringSeq;
    const bursts = [];
    for (let b = 0; b < randint(1, 3); b++) {
      const s = START + rand() * (END - START - 60 * DAY);
      bursts.push([s, s + randint(20, 90) * DAY]);
    }
    rings.push({ ring: ringSeq, members, bursts, district: pick(stDistricts).district });
  }
  ringsByState[st] = rings;
}

// ---------------- investigating officers ----------------
// Officers belong to a station. Drawing a fresh random name per case produced 216,096
// distinct officers across 1.5M cases, which makes any workload or performance view
// meaningless — every officer had a handful of cases and nobody had a caseload.
const officersByStation = new Map();
for (const d of DISTRICTS) {
  for (const [taluk, station] of d.stations) {
    const size = randint(6, 16);
    const roster = [];
    const seen = new Set();
    for (let i = 0; i < size * 3 && roster.length < size; i++) {
      const rank = weightedKey({ 'SI': 0.46, 'PSI': 0.24, 'ASI': 0.18, 'Insp': 0.09, 'DySP': 0.03 });
      const name = `${rank} ${nameFor(d, null, chance(0.9) ? 'M' : 'F')}`;
      if (seen.has(name)) continue;
      seen.add(name); roster.push(name);
    }
    officersByStation.set(station, roster);
  }
}
console.log(`  investigating officers: ${[...officersByStation.values()].reduce((a, r) => a + r.length, 0).toLocaleString('en-IN')} across ${officersByStation.size.toLocaleString('en-IN')} stations`);

// ---------------- assemble records ----------------
console.log('Assembling case, person, network and risk records…');
const wCases = csvWriter(SEED_DIR, 'Cases', ['CaseMasterID', 'CrimeNo', 'CaseNo', 'CrimeRegisteredDate', 'Year',
  'CrimeMonth', 'IncidentDate', 'StateName', 'DistrictName', 'TalukName', 'LocalityName', 'StationName',
  'latitude', 'longitude', 'CaseCategory', 'Gravity', 'CrimeHead', 'CrimeSubHead', 'CaseStatus',
  'CourtName', 'OfficerName', 'ActsSections', 'AccusedCount', 'VictimCount', 'BriefFacts']);
const wAccused = csvWriter(SEED_DIR, 'Accused', ['AccusedMasterID', 'CaseMasterID', 'CrimeNo', 'AccusedName',
  'AgeYear', 'Gender', 'PersonID', 'RingID', 'DistrictName', 'CrimeSubHead']);
const wVictims = csvWriter(SEED_DIR, 'Victims', ['VictimMasterID', 'CaseMasterID', 'VictimName', 'AgeYear',
  'Gender', 'Caste', 'Religion']);
const wComplainants = csvWriter(SEED_DIR, 'Complainants', ['ComplainantID', 'CaseMasterID', 'ComplainantName',
  'AgeYear', 'Gender', 'Occupation', 'Religion', 'Caste']);
const wArrests = csvWriter(SEED_DIR, 'Arrests', ['ArrestID', 'CaseMasterID', 'AccusedMasterID', 'AccusedName',
  'ArrestType', 'ArrestDate', 'DistrictName', 'IOName']);
const wTxns = csvWriter(SEED_DIR, 'FinancialTxns', ['TxnID', 'AccusedMasterID', 'AccusedName', 'Counterparty',
  'Amount', 'TxnDate', 'AccountRef']);

let aId = 1, vId = 1, cpId = 1, arrId = 1, txnId = 1;
const serial = new Map();          // FIR serial per station per year -> CaseNo
const districtSerial = new Map();  // serial per district per year -> CrimeNo
const offenderStats = new Map();
// Only recurring (pool) offenders enter the co-offending graph. One-off accused
// produce a pair that never repeats, which is noise in a network view and the
// dominant memory cost at scale.
const edges = new Map();
const headCount = new Int32Array(HEADS.length);
const stateCount = new Map();
const statusCount = new Map();
const yearCount = new Map();
const stateTried = new Map();
const stateHeadTop = new Map();
const detectionByGroup = new Map();
let heinousCount = 0;

// Court pendency in India runs around 90%: NCRB 2023 reported 23.0 lakh of 25.4
// lakh crime-against-women cases still pending trial at year end. Only the small
// disposed remainder splits by the state's conviction rate.
const TRIAL_PENDENCY = 0.82;
/**
 * Decides detection and status together, because they are not independent and treating
 * them as such produced records that contradict themselves: over half of the cases
 * filed as "Closed - Undetected" carried a named accused and an arrest, and a third of
 * convictions had no arrest at all. An undetected case is one where no offender was
 * identified, so it gets no accused and no arrest; a conviction always has both.
 */
function outcomeFor(cal, detectP, ageDays) {
  const matured = Math.min(1, ageDays / 420);
  if (rand() > detectP) {
    // Untraced. Young cases are still open; older ones are filed as undetected.
    return { detected: false, status: rand() < matured * 0.7 ? 'Closed - Undetected' : 'Under Investigation' };
  }
  if (rand() > matured) return { detected: true, status: 'Under Investigation' };
  const pend = TRIAL_PENDENCY - 0.14 * Math.min(1, ageDays / (YEARS_SPAN * 365));
  if (rand() < pend) return { detected: true, status: 'Pending Trial' };
  return { detected: true, status: rand() < cal.convictionRate / 100 ? 'Convicted' : 'Acquitted' };
}

for (let n = 0; n < evN; n++) {
  const ev = order[n];
  const d = DISTRICTS[evDi[ev]];
  const h = HEADS[evHi[ev]];
  const cal = STATE_CAL.get(d.state);
  const loc = d.locs[evLoc[ev]];
  const cid = n + 1;
  const t = evT[ev];
  const dt = new Date(t);
  const year = dt.getUTCFullYear(), month = dt.getUTCMonth() + 1;
  const station = d.stations.get(loc.taluk) || `${d.district} PS`;
  const cat = chance(0.84) ? 'FIR' : pick(['UDR', 'PAR', 'Zero FIR']);
  // FIR numbering is per station per year, which is how it works in practice, so
  // CaseNo reads as "123/2026". CrimeNo stays the globally unique record identifier.
  const sKey = station + '|' + year;
  const sNext = (serial.get(sKey) || 0) + 1;
  serial.set(sKey, sNext);
  // CrimeNo is the globally unique record identifier, so its serial runs per district
  // per year. A previous version folded the row id modulo 100,000 into it, which wrapped
  // and produced 45 duplicate CrimeNos in a 1.5M-case run.
  const dKey = d.code + '|' + year;
  const dNext = (districtSerial.get(dKey) || 0) + 1;
  districtSerial.set(dKey, dNext);
  const crimeNo = `${CAT_CODE[cat]}${pad(d.code, 4)}${pad((evLoc[ev] % 9999) + 1, 4)}${year}${pad(dNext, 6)}`;
  const ageDays = (END - t) / DAY;
  const { detected, status } = outcomeFor(cal, stateHeadWeights.get(d.state).detect[evHi[ev]], ageDays);

  // ---- accused: organised ring during an active burst, else pool or one-off
  const pool = offendersByState[d.state];
  const organised = h.group === 'Property Offences' || h.group === 'Economic Offences'
    || h.group === 'Narcotics' || h.group === 'Arms & Explosives' || h.group === 'Liquor & Excise';
  let activeRing = null;
  if (organised) {
    const rings = ringsByState[d.state] || [];
    for (const rg of rings) {
      if (rg.district !== d.district) continue;
      for (const [a, b] of rg.bursts) if (t >= a && t <= b) { activeRing = rg; break; }
      if (activeRing) break;
    }
  }
  // An undetected case has no identified offender, so it carries no accused record.
  const nA = !detected ? 0
    : h.group === 'Public Order' ? randint(2, 6)
      : h.group === 'Traffic & Negligence' ? 1
        : h.group === 'Regulatory & Local Acts' ? randint(1, 2) : randint(1, 3);
  const caseAcc = [];
  const recurring = [];
  const pw = poolWeightByState[d.state];
  for (let a = 0; a < nA; a++) {
    let off;
    if (activeRing && chance(0.6)) off = pick(activeRing.members);
    else if (chance(REPEAT_SHARE)) off = pool[weightedIndex(pw.w, pw.tot)];
    else {
      const g = chance(0.91) ? 'M' : 'F';
      off = { name: nameFor(d, null, g), ring: 0, age: accusedAge(), gender: g, known: false };
    }
    wAccused.write({
      AccusedMasterID: aId++, CaseMasterID: cid, CrimeNo: crimeNo, AccusedName: off.name,
      AgeYear: off.age || accusedAge(), Gender: off.gender || 'M', PersonID: 'A' + (a + 1),
      RingID: off.ring || 0, DistrictName: d.district, CrimeSubHead: h.head,
    });
    caseAcc.push(off.name);
    // Only pool offenders are tracked for risk profiling and the co-offending graph.
    // Names are not unique keys — in India, as in the real records, distinct people
    // share a name — so counting every accused record by name would fold thousands of
    // unrelated first-time accused into one apparent career criminal. Pool identities
    // are constructed distinct, so the derived tables describe genuinely identified
    // repeat offenders.
    if (!off.known) continue;
    recurring.push(off.name);
    const st = offenderStats.get(off.name) || { total: 0, violent: 0, ring: 0, state: d.state };
    st.total++; if (h.gravity === 'Heinous') st.violent++; if (off.ring) st.ring = off.ring;
    offenderStats.set(off.name, st);
  }
  const uniqRec = [...new Set(recurring)];
  for (let i = 0; i < uniqRec.length; i++) {
    for (let j = i + 1; j < uniqRec.length; j++) {
      const k = uniqRec[i] < uniqRec[j] ? uniqRec[i] + '||' + uniqRec[j] : uniqRec[j] + '||' + uniqRec[i];
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }

  // ---- victims
  // Victim counts follow the offence. Excise, gambling, arms possession and most
  // regulatory offences have no individual victim; theft and fraud always have one.
  // The previous blanket randint(0,1) gave victimless offences victims half the time
  // and left property crimes without one, which also skewed the victim table female,
  // since crimes against women were the only group guaranteed a victim record.
  const womanVictim = h.group === 'Crime Against Women';
  const childVictim = h.group === 'Crime Against Children';
  const nV = VICTIMLESS.has(h.group) ? 0
    : h.group === 'Traffic & Negligence' ? randint(1, 3)
      : h.group === 'Body Offences' ? randint(1, 2)
        : (womanVictim || childVictim) ? 1
          : h.group === 'Public Order' ? randint(0, 2)
            : 1;
  for (let v = 0; v < nV; v++) {
    const pd = personDemo(d);
    const g = womanVictim ? 'F' : childVictim ? (chance(0.72) ? 'F' : 'M') : (chance(0.55) ? 'M' : 'F');
    wVictims.write({
      VictimMasterID: vId++, CaseMasterID: cid, VictimName: nameFor(d, pd.religion, g),
      // Minors are victims of far more than the offences filed under crimes against
      // children — road accidents and assault included.
      AgeYear: childVictim ? randint(3, 17) : (chance(0.07) ? randint(4, 17) : adultAge(d)),
      Gender: g, Caste: pd.caste, Religion: pd.religion,
    });
  }

  // ---- complainant
  {
    const pd = personDemo(d);
    const g = womanVictim ? (chance(0.82) ? 'F' : 'M') : (chance(0.58) ? 'M' : 'F');
    const age = adultAge(d);
    wComplainants.write({
      ComplainantID: cpId++, CaseMasterID: cid, ComplainantName: nameFor(d, pd.religion, g),
      AgeYear: age, Gender: g,
      Occupation: occupationFor(d, g, age), Religion: pd.religion, Caste: pd.caste,
    });
  }

  // ---- arrest: only possible once an offender has been identified, and effectively
  // certain for any case that reached court.
  const inCourt = status === 'Pending Trial' || status === 'Convicted' || status === 'Acquitted';
  if (detected && caseAcc.length && (inCourt ? chance(0.985) : chance(0.55))) {
    wArrests.write({
      ArrestID: arrId++, CaseMasterID: cid, AccusedMasterID: 0, AccusedName: pick(caseAcc),
      ArrestType: chance(0.85) ? 'Arrest' : 'Surrender',
      ArrestDate: new Date(Math.min(END - DAY, t + randint(0, 30) * DAY)).toISOString().slice(0, 10),
      DistrictName: d.district, IOName: pick(officersByStation.get(station) || [nameFor(d)]),
    });
  }

  // ---- money trail for economic and cyber offences
  if (caseAcc.length && (h.gravity === 'Economic' || h.group === 'Cyber Crime')) {
    for (let k = 0, nT = randint(2, 6); k < nT; k++) {
      // Log-uniform amounts: many small frauds, a few very large ones.
      const amount = Math.round(Math.exp(Math.log(3000) + rand() * (Math.log(9e6) - Math.log(3000))));
      wTxns.write({
        TxnID: txnId++, AccusedMasterID: 0, AccusedName: pick(caseAcc),
        Counterparty: nameFor(d), Amount: amount,
        TxnDate: new Date(Math.min(END - DAY, t + randint(0, 20) * DAY)).toISOString().slice(0, 19).replace('T', ' '),
        AccountRef: 'AC' + randint(10000000, 99999999),
      });
    }
  }

  // Cascade jitter can carry an incident across a district line, leaving a point
  // plotted in one district while the record names another. Clamp to the district's own
  // bounding box so the map and the label always agree.
  const bb = d.bbox;
  const lat = Math.min(bb[3], Math.max(bb[1], evLat[ev]));
  const lng = Math.min(bb[2], Math.max(bb[0], evLng[ev]));
  wCases.write({
    CaseMasterID: cid, CrimeNo: crimeNo, CaseNo: `${sNext}/${year}`,
    CrimeRegisteredDate: dt.toISOString().slice(0, 10), Year: year, CrimeMonth: month,
    IncidentDate: dt.toISOString().slice(0, 19).replace('T', ' '),
    StateName: d.state, DistrictName: d.district, TalukName: loc.taluk, LocalityName: loc.name,
    StationName: station,
    latitude: lat.toFixed(5), longitude: lng.toFixed(5),
    CaseCategory: cat, Gravity: h.gravity, CrimeHead: h.group, CrimeSubHead: h.head,
    CaseStatus: status,
    CourtName: `${d.district} District & Sessions Court`,
    OfficerName: pick(officersByStation.get(station) || [nameFor(d)]),
    ActsSections: h.law, AccusedCount: nA, VictimCount: nV,
    BriefFacts: `A case of ${h.head.toLowerCase()} was registered at ${station} on the complaint received `
      + `from ${loc.name}, ${loc.taluk} taluk, ${d.district} district (${d.state}). Investigation was taken up `
      + `under ${h.law}; the scene of offence was examined and available evidence collected.`,
  });

  // running tallies for the quality report
  headCount[evHi[ev]]++;
  if (!stateHeadTop.has(d.state)) stateHeadTop.set(d.state, new Map());
  const shm = stateHeadTop.get(d.state);
  shm.set(h.head, (shm.get(h.head) || 0) + 1);
  const dg = detectionByGroup.get(h.group) || { n: 0, det: 0 };
  dg.n++; if (detected) dg.det++;
  detectionByGroup.set(h.group, dg);
  stateCount.set(d.state, (stateCount.get(d.state) || 0) + 1);
  statusCount.set(status, (statusCount.get(status) || 0) + 1);
  yearCount.set(year, (yearCount.get(year) || 0) + 1);
  if (h.gravity === 'Heinous') heinousCount++;
  if (status === 'Convicted' || status === 'Acquitted') {
    const s = stateTried.get(d.state) || { tried: 0, conv: 0 };
    s.tried++; if (status === 'Convicted') s.conv++;
    stateTried.set(d.state, s);
  }
  if (n && n % 500000 === 0) process.stdout.write(`\r  ${(n / 1e6).toFixed(1)}M cases…   `);
}
process.stdout.write('\r');

console.log('\nWriting app tables (datastore/seed):');
const nCases = wCases.close();
wAccused.close(); wVictims.close(); wComplainants.close(); wArrests.close(); wTxns.close();

// ---------------- co-accused graph + offender risk ----------------
const ringByName = new Map();
for (const st of statesList) for (const o of offendersByState[st]) if (o.ring) ringByName.set(o.name, o.ring);

const wLinks = csvWriter(SEED_DIR, 'CoAccusedLinks', ['LinkID', 'AccusedA', 'AccusedB', 'SharedCases', 'RingID']);
{
  const rows = [];
  for (const [k, shared] of edges) {
    const i = k.indexOf('||');
    rows.push([k.slice(0, i), k.slice(i + 2), shared]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  rows.forEach(([a, b, shared], i) => wLinks.write({
    LinkID: i + 1, AccusedA: a, AccusedB: b, SharedCases: shared,
    RingID: ringByName.get(a) || ringByName.get(b) || 0,
  }));
}
wLinks.close();

const wRisk = csvWriter(SEED_DIR, 'OffenderRisk', ['OffenderRiskID', 'AccusedName', 'TotalCases', 'ViolentCases',
  'RingID', 'RiskScore', 'RiskBand', 'Factors']);
{
  const rows = [];
  for (const [name, s] of offenderStats) {
    if (s.total < 2) continue;
    // Smooth saturation rather than a hard cap. The previous linear score hit 100 at
    // about fifteen cases, which put a quarter of all offenders in the High band and
    // made the band useless for prioritisation.
    const load = 0.055 * s.total + 0.16 * s.violent + (s.ring ? 0.45 : 0);
    const score = Math.round(100 * (1 - Math.exp(-load)));
    rows.push({ name, s, score });
  }
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => wRisk.write({
    OffenderRiskID: i + 1, AccusedName: r.name, TotalCases: r.s.total, ViolentCases: r.s.violent,
    RingID: r.s.ring || 0, RiskScore: r.score,
    RiskBand: r.score >= 75 ? 'High' : r.score >= 45 ? 'Medium' : 'Low',
    Factors: `${r.s.total} cases; ${r.s.violent} violent${r.s.ring ? '; organised-ring member' : ''}; ${r.s.state}`,
  }));
}
wRisk.close();

// District reference for the backend hotspot map.
const districtOut = DISTRICTS.map((d) => ({
  state: d.state, district: d.district, lat: d.lat, lng: d.lng,
  population: d.pop, stateCrimeRate: STATE_CAL.get(d.state).crimeRate,
}));
fs.writeFileSync(path.join(REF_DIR, 'india_districts.json'), JSON.stringify(districtOut));
const apiRef = path.join(__dirname, '..', 'functions', 'api', 'ref');
fs.mkdirSync(apiRef, { recursive: true });
fs.writeFileSync(path.join(apiRef, 'india_districts.json'), JSON.stringify(districtOut));
console.log(`  ref/india_districts.json + functions/api/ref/  ->  ${districtOut.length} districts`);

// ---------------- quality report ----------------
const fmt = (n) => n.toLocaleString('en-IN');
const pct = (a, b) => (b ? (a / b * 100) : 0);
console.log('\n──────── CALIBRATION / QUALITY REPORT ────────');
console.log(`Total cases        : ${fmt(nCases)}`);
console.log(`Near-repeat share  : ${pct(evN - bgCount, evN).toFixed(1)}%  (literature: 20-45%)`);
console.log(`Heinous share      : ${pct(heinousCount, nCases).toFixed(1)}%`);
console.log(`States/UTs covered : ${stateCount.size} of ${ncrb.states.length}`);
console.log(`Districts covered  : ${DISTRICTS.length}   Crime heads used: ${headCount.filter((c) => c > 0).length} of ${HEADS.length}`);

console.log('\nState volume fidelity (generated share vs real NCRB 2023 share):');
const realTotal = [...stateCount.keys()].reduce((a, s) => a + STATE_CAL.get(s).totalCrimes, 0);
[...stateCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([s, n]) => {
  const real = pct(STATE_CAL.get(s).totalCrimes, realTotal);
  console.log(`  ${s.padEnd(20)} gen ${pct(n, nCases).toFixed(2)}%  real ${real.toFixed(2)}%  (${fmt(n)} cases)`);
});
console.log('  … lowest 5:');
[...stateCount.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5).forEach(([s, n]) => {
  console.log(`  ${s.padEnd(20)} gen ${pct(n, nCases).toFixed(3)}%  real ${pct(STATE_CAL.get(s).totalCrimes, realTotal).toFixed(3)}%  (${fmt(n)} cases)`);
});

console.log('\nCrime-group mix (generated vs NCRB 2022 share):');
const groupGen = new Map(), groupReal = new Map();
HEADS.forEach((h, i) => {
  groupGen.set(h.group, (groupGen.get(h.group) || 0) + headCount[i]);
  groupReal.set(h.group, (groupReal.get(h.group) || 0) + h.cases);
});
[...groupGen.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => {
  console.log(`  ${g.padEnd(28)} gen ${pct(n, nCases).toFixed(2)}%  real ${pct(groupReal.get(g), HEAD_TOTAL).toFixed(2)}%`);
});

console.log('\nTop 12 crime heads:');
[...HEADS.keys()].sort((a, b) => headCount[b] - headCount[a]).slice(0, 12).forEach((i) => {
  console.log(`  ${HEADS[i].head.slice(0, 44).padEnd(45)} gen ${pct(headCount[i], nCases).toFixed(2)}%  real ${pct(HEADS[i].cases, HEAD_TOTAL).toFixed(2)}%`);
});

console.log('\nCase status mix:');
[...statusCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
  console.log(`  ${s.padEnd(24)} ${pct(n, nCases).toFixed(1)}%`);
});
console.log('\nCases per year:');
[...yearCount.keys()].sort().forEach((y) => console.log(`  ${y}: ${fmt(yearCount.get(y))}`));

console.log('\nDetection rate by crime group (offender identified):');
[...detectionByGroup.entries()].sort((a, b) => b[1].det / b[1].n - a[1].det / a[1].n)
  .forEach(([g, v]) => console.log(`  ${g.padEnd(28)} ${pct(v.det, v.n).toFixed(1)}%`));

console.log('\nOutcome fidelity (generated conviction rate vs NCRB 2023):');
['Kerala', 'West Bengal', 'Uttar Pradesh', 'Karnataka', 'Delhi', 'Gujarat', 'Bihar'].forEach((s) => {
  const t = stateTried.get(s);
  if (!t || !t.tried) return;
  console.log(`  ${s.padEnd(16)} generated ${pct(t.conv, t.tried).toFixed(0)}%  NCRB ${STATE_CAL.get(s).convictionRate}%`);
});

// State head mix is taken straight from NCRB, so the check is that a state's generated
// mix tracks its own published mix — not the national one.
console.log('\nPer-state head-mix fidelity (largest head in each of six states):');
['Gujarat', 'Tamil Nadu', 'Kerala', 'Bihar', 'Uttar Pradesh', 'Maharashtra'].forEach((st) => {
  const real = STATE_HEADS[st]; if (!real) return;
  const vol = STATE_VOLUME.get(st);
  const topHead = Object.entries(real).sort((a, b) => b[1] - a[1])[0][0];
  const hi = HEADS.findIndex((h) => h.head === topHead);
  const genState = stateHeadTop.get(st) || new Map();
  const genTot = stateCount.get(st) || 1;
  console.log(`  ${st.padEnd(16)} ${topHead.slice(0, 40).padEnd(41)} gen ` +
    `${pct(genState.get(topHead) || 0, genTot).toFixed(1)}%  real ${pct(real[topHead], vol).toFixed(1)}%`);
});
const unusedHeads = HEADS.filter((h, i) => headCount[i] === 0);
if (unusedHeads.length) {
  console.log(`Heads with no case at this scale: ${unusedHeads.length} ` +
    `(national share below ~1 in ${fmt(Math.round(nCases / 1))}; they appear at larger --cases)`);
}

const totalRows = nCases + wAccused.count + wVictims.count + wComplainants.count
  + wArrests.count + wLinks.count + wRisk.count + wTxns.count;
console.log(`\nTotal rows across 8 tables: ${fmt(totalRows)}`);
console.log(`Data Store load cost      : ~${fmt(Math.ceil(totalRows / 200))} API calls at 200 rows/batch`);
if (Math.ceil(totalRows / 200) > 180000) {
  console.log('  WARNING: this exceeds the 200,000-call development budget. Reduce --cases or use bulk import.');
}
console.log('──────────────────────────────────────────────');
console.log('DONE.  Load with:  node datastore/load.js');
