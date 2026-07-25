'use strict';

/**
 * Compact Data Store schema + ZCQL rules used to ground the text-to-ZCQL step.
 * Denormalized: names are embedded in each table, so queries are single-table
 * (no joins needed), which keeps generated ZCQL reliable.
 */

const SCHEMA_PROMPT = `DATABASE SCHEMA (Catalyst Data Store, query with ZCQL — SQL-like).
All tables are denormalized; names are embedded so you never need JOINs.

Cases(CaseMasterID, CrimeNo, CaseNo, CrimeRegisteredDate, Year, CrimeMonth, IncidentDate,
  StateName, DistrictName, TalukName, LocalityName, StationName, latitude, longitude,
  CaseCategory, Gravity, CrimeHead, CrimeSubHead, CaseStatus, CourtName, OfficerName,
  ActsSections, AccusedCount, VictimCount, BriefFacts)
  -- Coverage is all-India across all 36 states/UTs and 640 districts. The geography is
  -- four levels deep: StateName > DistrictName > TalukName (sub-district) >
  -- LocalityName (village, town or urban locality). Group by StateName for national
  -- comparisons, DistrictName for district detail, TalukName or LocalityName to
  -- pinpoint a specific area.
Accused(AccusedMasterID, CaseMasterID, CrimeNo, AccusedName, AgeYear, Gender, PersonID,
  RingID, DistrictName, CrimeSubHead)
Victims(VictimMasterID, CaseMasterID, VictimName, AgeYear, Gender, Caste, Religion)
Complainants(ComplainantID, CaseMasterID, ComplainantName, AgeYear, Gender, Occupation,
  Religion, Caste)
Arrests(ArrestID, CaseMasterID, AccusedMasterID, AccusedName, ArrestType, ArrestDate,
  DistrictName, IOName)
CoAccusedLinks(LinkID, AccusedA, AccusedB, SharedCases, RingID)   -- criminal network edges
OffenderRisk(OffenderRiskID, AccusedName, TotalCases, ViolentCases, RingID, RiskScore,
  RiskBand, Factors)   -- repeat-offender profiling; RiskScore 0-100, RiskBand High/Medium/Low
FinancialTxns(TxnID, AccusedMasterID, AccusedName, Counterparty, Amount, TxnDate, AccountRef)

VALUE HINTS:
- CrimeHead is one of 16 groups: 'Body Offences','Property Offences','Crime Against Women',
  'Crime Against Children','Kidnapping & Trafficking','Economic Offences','Cyber Crime',
  'Narcotics','Liquor & Excise','Public Order','Traffic & Negligence','Caste Atrocities',
  'Arms & Explosives','Offences Against the State','Environment & Wildlife',
  'Regulatory & Local Acts'
- CrimeSubHead holds the specific NCRB crime head (186 values). Prefer filtering on
  CrimeHead when the user names a broad category, and use LIKE on CrimeSubHead when they
  name a specific offence, because the exact wording is long. Examples:
  'Murder', 'Theft', 'Motor Vehicle Theft', 'Robbery', 'Dacoity', 'Burglary by Night',
  'Rape', 'Cruelty by Husband or his Relatives', 'Dowry Death', 'Stalking',
  'Voluntarily Causing Simple Hurt', 'Attempt to Commit Murder', 'Cheating', 'Forgery',
  'Bank Fraud', 'Possession of Drugs for Trafficking', 'Offence under the Excise Act',
  'Offence under the State Prohibition Act', 'Offence under the Gambling Act',
  'Offence under the Information Technology Act', 'Rash Driving on Public Way',
  'Hit and Run', 'Atrocity against Scheduled Caste',
  'Penetrative Sexual Assault on Child (POCSO)'
  e.g. WHERE CrimeSubHead LIKE '%Theft%'  or  WHERE CrimeHead='Narcotics'
- Gravity: 'Heinous','Non-Heinous','Economic'
- CaseStatus: 'Under Investigation','Pending Trial','Convicted','Acquitted','Closed - Undetected'
- CaseCategory: 'FIR','UDR','PAR','Zero FIR'
- Gender: 'M','F','T'
- Caste: 'General','OBC','SC','ST'   Religion: 'Hindu','Muslim','Christian','Sikh','Buddhist','Jain','Other'
- StateName: all 36 states/UTs, e.g. 'Uttar Pradesh','Maharashtra','Kerala','Karnataka',
  'Tamil Nadu','Gujarat','Bihar','Delhi','West Bengal','Telangana','Ladakh'
- ActsSections holds the charging provision, e.g. 'BNS 103 / IPC 302', 'NDPS Act 1985 s.21/22/29'
- Dates are TEXT in 'YYYY-MM-DD'. Year is INT (2023-2026). CrimeMonth is INT 1-12.

ZCQL RULES (strict):
- SELECT queries only. One table per query. No JOINs, no subqueries, no semicolons.
- ALWAYS include a LIMIT (max 200). Use COUNT(ROWID) for counts, with GROUP BY for breakdowns.
- Strings in single quotes. Use LIKE '%term%' for partial text (e.g. BriefFacts, names).
- Use exact table and column names above. ROWID exists on every table.
- Examples:
  SELECT StateName, COUNT(ROWID) FROM Cases GROUP BY StateName ORDER BY COUNT(ROWID) DESC LIMIT 40
  SELECT CrimeNo, CrimeSubHead, DistrictName, CaseStatus FROM Cases WHERE CrimeSubHead='Murder' AND Year=2026 LIMIT 50
  SELECT TalukName, COUNT(ROWID) FROM Cases WHERE DistrictName='Pune' GROUP BY TalukName ORDER BY COUNT(ROWID) DESC LIMIT 30
  SELECT AccusedName, RiskScore, RiskBand, Factors FROM OffenderRisk WHERE RiskBand='High' ORDER BY RiskScore DESC LIMIT 25`;

module.exports = { SCHEMA_PROMPT };
