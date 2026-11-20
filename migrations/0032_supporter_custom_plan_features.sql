-- Per-contract feature flags for admin-issued custom plans.
-- features_json is a JSON array of sorted feature names from site/supporter/plan-features.js
-- (FEATURE_NAMES), e.g. ["eewMap","hiresRadar",...]. NULL = not migrated yet; the Worker then
-- derives the same list from the legacy columns (legacyCustomFeatureNames()).
-- The legacy columns stay and are kept in sync by the Worker:
--   complex_conditions     = complexConditions
--   municipality_branching = municipalityScope
--   content_extraction     = strictMunicipality
--   multi_destination      = multiDestination
-- Existing contracts keep exactly what they had: every image feature (custom used to match Pro),
-- the rainfall threshold, and the text-rule features of their legacy columns.
ALTER TABLE supporter_custom_plans ADD COLUMN features_json TEXT;

UPDATE supporter_custom_plans SET features_json = '['
 || CASE WHEN complex_conditions = 1 THEN '"complexConditions",' ELSE '' END
 || '"earthquakeMap","earthquakeMapFilter","eewMap","eewMapRegion","hiresRadar","hiresRadarThreshold",'
 || CASE WHEN multi_destination = 1 THEN '"multiDestination",' ELSE '' END
 || CASE WHEN municipality_branching = 1 THEN '"municipalityScope","prefectureScope",' ELSE '' END
 || '"rainfallThreshold",'
 || CASE WHEN municipality_branching = 1 AND content_extraction = 1 THEN '"strictMunicipality",' ELSE '' END
 || '"tsunamiEnlarged","tsunamiMap","warningTableEvery","warningTableNational","warningTableRegional","warningTableTimeseries","weatherMap","weatherMunicipality"]'
WHERE features_json IS NULL;
