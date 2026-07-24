'use strict';

/**
 * Compact Data Store schema + ZCQL rules used to ground the text-to-ZCQL step.
 * Denormalized: names are embedded in each table, so queries are single-table
 * (no joins needed), which keeps generated ZCQL reliable.
 */

const SCHEMA_PROMPT = `DATABASE SCHEMA (Catalyst Data Store, query with ZCQL — SQL-like).
All tables are denormalized; names are embedded so you never need JOINs.

Cases(CaseMasterID, CrimeNo, CaseNo, CrimeRegisteredDate, Year, CrimeMonth, IncidentDate,
  DistrictName, StationName, latitude, longitude, CaseCategory, Gravity, CrimeHead,
  CrimeSubHead, CaseStatus, CourtName, OfficerName, ActsSections, AccusedCount,
  VictimCount, BriefFacts)
Accused(AccusedMasterID, CaseMasterID, CrimeNo, AccusedName, AgeYear, Gender, PersonID,
  RingID, DistrictName, CrimeSubHead)
Victims(VictimMasterID, CaseMasterID, VictimName, AgeYear, Gender)
Complainants(ComplainantID, CaseMasterID, ComplainantName, AgeYear, Gender, Occupation,
  Religion, Caste)
Arrests(ArrestID, CaseMasterID, AccusedMasterID, AccusedName, ArrestType, ArrestDate,
  DistrictName, IOName)
CoAccusedLinks(LinkID, AccusedA, AccusedB, SharedCases, RingID)   -- criminal network edges
OffenderRisk(OffenderRiskID, AccusedName, TotalCases, ViolentCases, RingID, RiskScore,
  RiskBand, Factors)   -- repeat-offender profiling; RiskScore 0-100, RiskBand High/Medium/Low
FinancialTxns(TxnID, AccusedMasterID, AccusedName, Counterparty, Amount, TxnDate, AccountRef)

VALUE HINTS:
- CrimeHead: 'Body Offences','Property Offences','Crime Against Women','Economic Offences','Cyber Crime','Narcotics','Public Order'
- CrimeSubHead: e.g. 'Murder','Robbery','Burglary','Theft','Dowry Harassment','Online Fraud','UPI Fraud','Possession NDPS'
- Gravity: 'Heinous','Non-Heinous','Economic'
- CaseStatus: 'Under Investigation','Chargesheet Filed','Convicted','Acquitted','Closed - Undetected','Pending Trial'
- CaseCategory: 'FIR','UDR','PAR','Zero FIR'
- Gender: 'M','F','T'
- DistrictName: 'Bengaluru City','Bengaluru Rural','Mysuru','Mangaluru (DK)','Hubballi-Dharwad','Belagavi','Kalaburagi','Ballari','Vijayapura','Shivamogga','Tumakuru','Davanagere','Udupi','Hassan','Raichur'
- Dates are TEXT in 'YYYY-MM-DD'. Year is INT (2024-2026). CrimeMonth is INT 1-12.

ZCQL RULES (strict):
- SELECT queries only. One table per query. No JOINs, no subqueries, no semicolons.
- ALWAYS include a LIMIT (max 200). Use COUNT(ROWID) for counts, with GROUP BY for breakdowns.
- Strings in single quotes. Use LIKE '%term%' for partial text (e.g. BriefFacts, names).
- Use exact table and column names above. ROWID exists on every table.
- Examples:
  SELECT DistrictName, COUNT(ROWID) FROM Cases GROUP BY DistrictName ORDER BY COUNT(ROWID) DESC LIMIT 20
  SELECT CrimeNo, CrimeSubHead, DistrictName, CaseStatus FROM Cases WHERE CrimeSubHead='Murder' AND Year=2026 LIMIT 50
  SELECT AccusedName, RiskScore, RiskBand, Factors FROM OffenderRisk WHERE RiskBand='High' ORDER BY RiskScore DESC LIMIT 25`;

module.exports = { SCHEMA_PROMPT };
