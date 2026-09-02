-- Deterministic mock data shaped like the lab workbooks in docs/example_data.
-- Names and identifiers follow the real workflow; measurements and timestamps
-- are generated examples anchored to the current Bangkok date.
BEGIN;

-- Remove the complete graph owned by prior demo batches, including records
-- created through the UI against those batches between compose runs.
UPDATE embryo SET first_abnormal_observation_id = NULL
WHERE injection_lot_id IN (SELECT id FROM injection_lot WHERE batch_id LIKE '61000000-%');
DELETE FROM specimen WHERE clone_fish_id IN (
 SELECT fish.id FROM clone_fish fish JOIN embryo ON embryo.id=fish.embryo_id
 JOIN injection_lot lot ON lot.id=embryo.injection_lot_id WHERE lot.batch_id LIKE '61000000-%'
);
DELETE FROM fish_observation WHERE clone_fish_id IN (
 SELECT fish.id FROM clone_fish fish JOIN embryo ON embryo.id=fish.embryo_id
 JOIN injection_lot lot ON lot.id=embryo.injection_lot_id WHERE lot.batch_id LIKE '61000000-%'
);
DELETE FROM clone_fish WHERE embryo_id IN (
 SELECT embryo.id FROM embryo JOIN injection_lot lot ON lot.id=embryo.injection_lot_id WHERE lot.batch_id LIKE '61000000-%'
);
DELETE FROM control_arm_count WHERE batch_id LIKE '61000000-%';
DELETE FROM embryo_observation WHERE embryo_id IN (
 SELECT embryo.id FROM embryo JOIN injection_lot lot ON lot.id=embryo.injection_lot_id WHERE lot.batch_id LIKE '61000000-%'
);
DELETE FROM embryo WHERE injection_lot_id IN (SELECT id FROM injection_lot WHERE batch_id LIKE '61000000-%');
DELETE FROM injection_lot WHERE batch_id LIKE '61000000-%';
DELETE FROM audit_log WHERE id LIKE '69000000-%';
DELETE FROM experiment_batch WHERE id LIKE '61000000-%';
DELETE FROM fish_box WHERE id LIKE '53000000-%';
DELETE FROM csof_lot WHERE id LIKE '52000000-%';
DELETE FROM recipient_egg_lot WHERE id LIKE '51000000-%';
DELETE FROM donor_cell_line WHERE id LIKE '54000000-%';

CREATE TEMP TABLE seed_mock_rows (
 batch_no INTEGER, site_code VARCHAR(10), operator_name VARCHAR(20), group_code VARCHAR(20),
 strain VARCHAR(20), replicate_no INTEGER, days_ago INTEGER, is_ongoing BOOLEAN,
 activated INTEGER, c2 INTEGER, c4 INTEGER, c8 INTEGER, c16 INTEGER, c32 INTEGER, c64 INTEGER,
 c256 INTEGER, c512 INTEGER, c1k INTEGER, high INTEGER, oblong INTEGER, sphere INTEGER, dome INTEGER,
 epi30 INTEGER, epi50 INTEGER, germ_ring INTEGER, shield INTEGER, epi75 INTEGER, epi90 INTEGER,
 day1 INTEGER, day3 INTEGER, day4 INTEGER, fry INTEGER, juvenile INTEGER, adult INTEGER
) ON COMMIT DROP;

WITH scenarios(batch_no,site_code,operator_name,group_code,strain,replicate_no,days_ago,is_ongoing) AS (VALUES
 (1,'KU','Jan','Control','AB',1,88,FALSE),
 (2,'KU','June','Control','TU',1,77,FALSE),
 (3,'KU','Jan','RK701','NHGRI',1,66,FALSE),
 (4,'MSU','June','Control','AB',1,55,FALSE),
 (5,'MSU','Jan','RK701','TU',1,44,FALSE),
 (6,'KU','June','RK701','AB',2,35,FALSE),
 (7,'MSU','Jan','Control','NHGRI',2,28,FALSE),
 (8,'KU','June','Control','TU',2,23,FALSE),
 (9,'MSU','Jan','RK701','AB',2,18,FALSE),
 (10,'KU','June','RK701','NHGRI',2,13,FALSE),
 (11,'MSU','Jan','Control','TU',3,8,FALSE),
 (12,'KU','June','Control','AB',3,0,TRUE)
), base AS (
 SELECT scenarios.*,36+((batch_no*7)%48) activated FROM scenarios
), modeled AS (
 SELECT base.*,
  CASE WHEN group_code='RK701' THEN .08 ELSE 0 END+
  CASE strain WHEN 'AB' THEN .03 WHEN 'NHGRI' THEN -.03 ELSE 0 END+
  CASE site_code WHEN 'MSU' THEN -.02 ELSE 0 END modifier
 FROM base
)
INSERT INTO seed_mock_rows
SELECT batch_no,site_code,operator_name,group_code,strain,replicate_no,days_ago,is_ongoing,activated,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.78*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.68*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.61*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.56*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.52*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.49*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.43*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.39*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.36*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.33*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.30*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.27*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.23*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.20*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.17*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.15*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.13*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.11*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.095*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.08*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.055*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN NULL ELSE FLOOR(activated*.045*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN 0 ELSE FLOOR(activated*.035*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN 0 ELSE FLOOR(activated*.025*(1+modifier))::integer END,
 CASE WHEN is_ongoing THEN 0 ELSE FLOOR(activated*.015*(1+modifier))::integer END
FROM modeled;

WITH donors(donor_no,strain,group_code) AS (VALUES
 (1,'AB','Control'),(2,'AB','RK701'),(3,'TU','Control'),
 (4,'TU','RK701'),(5,'NHGRI','Control'),(6,'NHGRI','RK701')
)
INSERT INTO donor_cell_line (id,strain,preparation,batch_code,active,created_at,updated_at)
SELECT CONCAT('54000000-0000-7000-8000-',LPAD(donor_no::text,12,'0')),strain,'DISSOCIATED',
 CONCAT(strain,TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date,'DDMMYY'),'_e48h_',LOWER(group_code)),
 TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM donors;

INSERT INTO recipient_egg_lot (id,breed,lot_date,label,active,created_at,updated_at)
SELECT CONCAT('51000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),'TAB Taiwan',
 (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago,
 CONCAT('E',((batch_no-1)%8)+1,'_',TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago,'YYYY-MM-DD')),
 TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM seed_mock_rows;

INSERT INTO csof_lot (id,lot_code,active,created_at,updated_at) VALUES
 ('52000000-0000-7000-8000-000000000001',CONCAT('CSOF ',TO_CHAR((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date,'YYYY-MM')),TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO fish_box (id,box_code,site_id,active,created_at,updated_at) VALUES
 ('53000000-0000-7000-8000-000000000001','KU-CLONE-01','10000000-0000-7000-8000-000000000001',TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
 ('53000000-0000-7000-8000-000000000002','MSU-CLONE-01','10000000-0000-7000-8000-000000000002',TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

INSERT INTO experiment_batch
 (id,batch_code,experiment_date,day_no,site_id,operator_id,protocol_id,timing_profile_id,treatment_group_id,recipient_egg_lot_id,csof_lot_id,clutch_code,replicate_no,incubation_temp_c,notes,created_at,updated_at)
SELECT CONCAT('61000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),
 CONCAT(batch_no,'_',operator_name,'_',group_code),(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago,batch_no,
 CASE site_code WHEN 'KU' THEN '10000000-0000-7000-8000-000000000001' ELSE '10000000-0000-7000-8000-000000000002' END,
 CASE operator_name WHEN 'Jan' THEN '20000000-0000-7000-8000-000000000001' ELSE '20000000-0000-7000-8000-000000000002' END,
 '01900000-0000-7000-8000-000000000001','01900000-0000-7000-8000-000000000002',
 CASE group_code WHEN 'Control' THEN '40000000-0000-7000-8000-000000000001' ELSE '40000000-0000-7000-8000-000000000002' END,
 CONCAT('51000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),'52000000-0000-7000-8000-000000000001',
 CONCAT('E',((batch_no-1)%8)+1),replicate_no,CASE site_code WHEN 'KU' THEN 28.5 ELSE 28.6 END,
 CONCAT('Mock SCNT run; Site=',site_code,'; Strain=',strain,'; Group=',group_code,'; format based on lab workbook'),
 (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago+TIME '09:30',CURRENT_TIMESTAMP
FROM seed_mock_rows;

WITH lot_data AS (
 SELECT row.*,
  -- ongoing lot activated 2h ago: keep it a real timestamptz so it never lands
  -- in the future (AT TIME ZONE 'Asia/Bangkok' yields a naive ts that the UTC
  -- session then reads back +7h, pushing "now - 2h" to "now + 5h").
  CASE WHEN is_ongoing THEN CURRENT_TIMESTAMP-INTERVAL '2 hours'
       ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago+TIME '10:00' END activated_at,
  CASE
   WHEN strain='AB' AND group_code='Control' THEN 1 WHEN strain='AB' THEN 2
   WHEN strain='TU' AND group_code='Control' THEN 3 WHEN strain='TU' THEN 4
   WHEN group_code='Control' THEN 5 ELSE 6 END donor_no
 FROM seed_mock_rows row
)
INSERT INTO injection_lot
 (id,batch_id,lot_no,donor_cell_line_id,enu_power_pct,enu_pulse_us,enu_led,enu_start_at,enu_finish_at,activated_at,n_eggs,n_activated,notes,created_at,updated_at)
SELECT CONCAT('62000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),
 CONCAT('61000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),replicate_no::text,
 CONCAT('54000000-0000-7000-8000-',LPAD(donor_no::text,12,'0')),100,500,CASE group_code WHEN 'Control' THEN 85 ELSE 80 END,
 activated_at-INTERVAL '15 minutes',activated_at-INTERVAL '5 minutes',activated_at,activated+4,activated,
 CONCAT('Mock lot using N in Lot / Activated fields; ',strain,' ',group_code),activated_at-INTERVAL '15 minutes',CURRENT_TIMESTAMP
FROM lot_data;

INSERT INTO embryo (id,injection_lot_id,seq_in_lot,embryo_code,well_position,created_at,updated_at)
SELECT CONCAT('63000000-0000-7000-8000-',LPAD((row.batch_no*1000+seq)::text,12,'0')),
 CONCAT('62000000-0000-7000-8000-',LPAD(row.batch_no::text,12,'0')),seq,
 CONCAT(row.batch_no,'_',row.operator_name,'_',row.group_code,'_',row.replicate_no,'_',seq),
 CONCAT(CHR(65+((seq-1)/12)::integer),((seq-1)%12)+1),lot.activated_at,CURRENT_TIMESTAMP
FROM seed_mock_rows row
JOIN injection_lot lot ON lot.id=CONCAT('62000000-0000-7000-8000-',LPAD(row.batch_no::text,12,'0'))
CROSS JOIN LATERAL generate_series(1,row.activated) seq;

WITH raw_counts AS (
 SELECT row.batch_no,stage.stage_order,stage.alive_count FROM seed_mock_rows row
 CROSS JOIN LATERAL (VALUES
  (1,row.activated),(2,row.c2),(3,row.c4),(4,row.c8),(5,row.c16),(6,row.c32),(7,row.c64),(9,row.c256),(10,row.c512),(11,row.c1k),
  (12,row.high),(13,row.oblong),(14,row.sphere),(15,row.dome),(16,row.epi30),(17,row.epi50),(18,row.germ_ring),(19,row.shield),
  (20,row.epi75),(21,row.epi90),(22,row.day1),(24,row.day3),(25,row.day4)
 ) stage(stage_order,alive_count) WHERE NOT row.is_ongoing
), checkpoints AS (
 SELECT raw_counts.*,COALESCE(LAG(alive_count) OVER(PARTITION BY batch_no ORDER BY stage_order),alive_count) previous_count FROM raw_counts
), rows AS (
 SELECT checkpoints.*,embryo.id embryo_id,embryo.seq_in_lot,lot.activated_at,batch.operator_id,timing.expected_hpa,
  CASE WHEN stage_order=1 THEN 0::numeric ELSE ((batch_no%3)-1)*.04+((embryo.seq_in_lot%5)-2)*.01 END deviation,
  CASE WHEN embryo.seq_in_lot<=alive_count THEN 'ALIVE' WHEN embryo.seq_in_lot%5=0 THEN 'DEGENERATED' ELSE 'DEAD' END outcome
 FROM checkpoints JOIN injection_lot lot ON lot.id=CONCAT('62000000-0000-7000-8000-',LPAD(batch_no::text,12,'0'))
 JOIN experiment_batch batch ON batch.id=lot.batch_id JOIN embryo ON embryo.injection_lot_id=lot.id AND embryo.seq_in_lot<=previous_count
 JOIN stage_timing timing ON timing.stage_definition_id=CONCAT('01900001-0000-7000-8000-',LPAD(stage_order::text,12,'0'))
)
INSERT INTO embryo_observation
 (id,client_uuid,embryo_id,stage_definition_id,observed_at,hpa_actual,hpa_expected_snapshot,deviation_h,outcome,biological_condition,operator_id,device_id,is_backdated,notes,created_at,updated_at)
SELECT CONCAT('64000000-0000-7000-8000-',LPAD((stage_order*1000000+batch_no*1000+seq_in_lot)::text,12,'0')),
 CONCAT('64100000-0000-7000-8000-',LPAD((stage_order*1000000+batch_no*1000+seq_in_lot)::text,12,'0')),embryo_id,
 CONCAT('01900001-0000-7000-8000-',LPAD(stage_order::text,12,'0')),activated_at+((expected_hpa+deviation)*INTERVAL '1 hour'),
 expected_hpa+deviation,expected_hpa,deviation,outcome,
 CASE WHEN outcome<>'ALIVE' THEN 'UNDETERMINED' WHEN stage_order>=13 AND seq_in_lot%17=0 THEN 'ABNORMAL' ELSE 'NORMAL' END,
 operator_id,'LAB-MOCK-01',TRUE,CASE WHEN outcome<>'ALIVE' THEN outcome WHEN stage_order>=13 AND seq_in_lot%17=0 THEN 'Ab' ELSE 'Nor' END,
 CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM rows;

INSERT INTO embryo_observation
 (id,client_uuid,embryo_id,stage_definition_id,observed_at,hpa_actual,hpa_expected_snapshot,deviation_h,outcome,biological_condition,operator_id,device_id,is_backdated,notes,created_at,updated_at)
SELECT CONCAT('64000000-0000-7000-8012-',LPAD(embryo.seq_in_lot::text,12,'0')),
 CONCAT('64100000-0000-7000-8012-',LPAD(embryo.seq_in_lot::text,12,'0')),embryo.id,
 '01900001-0000-7000-8000-000000000001',lot.activated_at,0,0,0,'ALIVE','NORMAL',
 '20000000-0000-7000-8000-000000000002','LAB-MOCK-01',FALSE,'Nor',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM embryo JOIN injection_lot lot ON lot.id=embryo.injection_lot_id
WHERE lot.id='62000000-0000-7000-8000-000000000012';

WITH first_exit AS (
 SELECT DISTINCT ON (observation.embryo_id) observation.embryo_id,observation.observed_at,observation.outcome,stage.id stage_id
 FROM embryo_observation observation JOIN stage_definition stage ON stage.id=observation.stage_definition_id
 WHERE observation.id LIKE '64000000-%' AND observation.outcome IN ('DEAD','DEGENERATED')
 ORDER BY observation.embryo_id,stage.stage_order
)
UPDATE embryo SET exit_stage_id=first_exit.stage_id,exit_at=first_exit.observed_at,exit_reason=first_exit.outcome,updated_at=CURRENT_TIMESTAMP
FROM first_exit WHERE embryo.id=first_exit.embryo_id;

UPDATE embryo SET exit_stage_id='01900001-0000-7000-8000-000000000026',exit_at=lot.activated_at+INTERVAL '120 hours',exit_reason='PROMOTED',updated_at=CURRENT_TIMESTAMP
FROM injection_lot lot,seed_mock_rows row WHERE embryo.injection_lot_id=lot.id
 AND lot.id=CONCAT('62000000-0000-7000-8000-',LPAD(row.batch_no::text,12,'0'))
 AND NOT row.is_ongoing AND embryo.exit_reason IS NULL AND embryo.seq_in_lot<=row.fry;

UPDATE embryo SET exit_stage_id='01900001-0000-7000-8000-000000000026',exit_at=lot.activated_at+INTERVAL '120 hours',exit_reason='DEAD',updated_at=CURRENT_TIMESTAMP
FROM injection_lot lot,seed_mock_rows row WHERE embryo.injection_lot_id=lot.id
 AND lot.id=CONCAT('62000000-0000-7000-8000-',LPAD(row.batch_no::text,12,'0')) AND NOT row.is_ongoing AND embryo.exit_reason IS NULL;

UPDATE embryo SET first_abnormal_observation_id=(
 SELECT observation.id FROM embryo_observation observation JOIN stage_definition stage ON stage.id=observation.stage_definition_id
 WHERE observation.embryo_id=embryo.id AND observation.biological_condition='ABNORMAL' ORDER BY stage.stage_order LIMIT 1
),updated_at=CURRENT_TIMESTAMP WHERE embryo.id LIKE '63000000-%';

WITH promoted AS (
 SELECT embryo.*,lot.activated_at,lot.donor_cell_line_id,batch.site_id,row.strain,row.replicate_no,row.juvenile,row.adult,
  ROW_NUMBER() OVER(ORDER BY row.batch_no,embryo.seq_in_lot)::integer running_no
 FROM embryo JOIN injection_lot lot ON lot.id=embryo.injection_lot_id JOIN experiment_batch batch ON batch.id=lot.batch_id
 JOIN seed_mock_rows row ON lot.id=CONCAT('62000000-0000-7000-8000-',LPAD(row.batch_no::text,12,'0'))
 WHERE embryo.exit_reason='PROMOTED'
)
INSERT INTO clone_fish
 (id,embryo_id,fish_code,running_no,dob,donor_cell_line_id,site_id,fish_box_id,status,biological_condition,first_abnormal_on,first_abnormal_age_days,first_abnormal_stage_id,sex,fin_clipped,exit_date,exit_reason,remarks,created_at,updated_at)
SELECT CONCAT('65000000-0000-7000-8000-',LPAD(running_no::text,12,'0')),id,
 CONCAT('No.',running_no,'_Clone',seq_in_lot,'-',strain,' cell-',replicate_no),running_no,activated_at::date,donor_cell_line_id,site_id,
 CASE WHEN site_id='10000000-0000-7000-8000-000000000001' THEN '53000000-0000-7000-8000-000000000001' ELSE '53000000-0000-7000-8000-000000000002' END,
 CASE WHEN seq_in_lot<=juvenile THEN 'ALIVE' WHEN running_no%2=0 THEN 'FROZEN' ELSE 'DISCARDED' END,
 CASE WHEN seq_in_lot%5=0 THEN 'ABNORMAL' ELSE 'NORMAL' END,CASE WHEN seq_in_lot%5=0 THEN activated_at::date+3 ELSE NULL END,
 CASE WHEN seq_in_lot%5=0 THEN 3 ELSE NULL END,CASE WHEN seq_in_lot%5=0 THEN '01900001-0000-7000-8000-000000000024' ELSE NULL END,
 CASE WHEN seq_in_lot<=adult THEN CASE WHEN running_no%2=0 THEN 'F' ELSE 'M' END ELSE 'UNKNOWN' END,seq_in_lot<=juvenile,
 CASE WHEN seq_in_lot<=juvenile THEN NULL ELSE activated_at::date+7 END,
 CASE WHEN seq_in_lot<=juvenile THEN NULL WHEN running_no%2=0 THEN 'FROZEN' ELSE 'DISCARDED' END,
 'Mock clone record using the lab fish-code convention',activated_at+INTERVAL '120 hours',CURRENT_TIMESTAMP FROM promoted;

UPDATE fish_running_sequence SET next_running_no=GREATEST(next_running_no,COALESCE((SELECT MAX(running_no)+1 FROM clone_fish),1));

WITH daily AS (
 SELECT fish.*,age_days,fish.dob+age_days observed_on FROM clone_fish fish CROSS JOIN generate_series(1,15) age_days
 WHERE fish.id LIKE '65000000-%'
  AND fish.dob+age_days<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date
  AND (fish.exit_date IS NULL OR fish.dob+age_days<=fish.exit_date)
), latest AS (
 SELECT fish.*,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-fish.dob age_days,
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date observed_on
 FROM clone_fish fish WHERE fish.id LIKE '65000000-%' AND fish.status='ALIVE'
  AND (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-fish.dob>15
), rows AS (SELECT *,FALSE is_latest FROM daily UNION ALL SELECT *,TRUE FROM latest)
INSERT INTO fish_observation
 (id,client_uuid,clone_fish_id,observed_on,age_days,outcome,biological_condition,operator_id,device_id,is_backdated,notes,created_at,updated_at)
SELECT CONCAT('66000000-0000-7000-8000-',LPAD((CASE WHEN is_latest THEN 900000000 ELSE 100000000+age_days*1000 END+running_no)::text,12,'0')),
 CONCAT('66100000-0000-7000-8000-',LPAD((CASE WHEN is_latest THEN 900000000 ELSE 100000000+age_days*1000 END+running_no)::text,12,'0')),
 id,observed_on,age_days,CASE WHEN exit_date=observed_on THEN status ELSE 'ALIVE' END,
 CASE WHEN biological_condition='ABNORMAL' AND age_days<3 THEN 'NORMAL' ELSE biological_condition END,
 CASE WHEN running_no%2=1 THEN '20000000-0000-7000-8000-000000000001' ELSE '20000000-0000-7000-8000-000000000002' END,
 'LAB-MOCK-01',TRUE,CASE WHEN is_latest THEN 'Latest roll call' ELSE CONCAT('d',age_days) END,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM rows;

INSERT INTO specimen
 (id,clone_fish_id,specimen_code,specimen_kind,specimen_type,collected_on,frozen_on,storage,notes,created_at,updated_at)
SELECT CONCAT('67000000-0000-7000-8000-',LPAD(running_no::text,12,'0')),id,CONCAT('CL',running_no),'CL',
 CASE WHEN status='ALIVE' THEN 'CAUDAL_FIN_CLIP' ELSE 'WHOLE_EMBRYO' END,
 CASE WHEN status<>'ALIVE' THEN exit_date WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date>=dob+45 THEN dob+45 ELSE NULL END,
 CASE WHEN status<>'ALIVE' THEN exit_date WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date>=dob+45 THEN dob+45 ELSE NULL END,
 CASE WHEN status<>'ALIVE' OR (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date>=dob+45 THEN '-80' ELSE NULL END,
 'Mock CL code; collection fields remain blank until the modeled collection date',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM clone_fish WHERE id LIKE '65000000-%';

INSERT INTO specimen
 (id,clone_fish_id,specimen_code,specimen_kind,specimen_type,collected_on,frozen_on,storage,notes,created_at,updated_at)
SELECT CONCAT('67000000-0000-7000-8000-',LPAD((1000+running_no)::text,12,'0')),id,CONCAT('RT',running_no),'RT','CAUDAL_FIN_CLIP',
 dob,dob,'-80','Mock recipient-tail reference paired with the clone',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM clone_fish WHERE id LIKE '65000000-%';

WITH ongoing AS (SELECT * FROM seed_mock_rows WHERE is_ongoing)
INSERT INTO control_arm_count (id,batch_id,arm_type,stage_definition_id,n_normal,n_abnormal,created_at,updated_at)
SELECT CONCAT('68000000-0000-7000-8000-',LPAD((stage_order*10+arm_no)::text,12,'0')),
 '61000000-0000-7000-8000-000000000012',arm_type,
 CONCAT('01900001-0000-7000-8000-',LPAD(stage_order::text,12,'0')),
 FLOOR(ongoing.activated*normal_ratio)::integer,FLOOR(ongoing.activated*abnormal_ratio)::integer,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM ongoing CROSS JOIN (VALUES
 (3,1,'NATURAL_BREEDING',.82,.05),(19,1,'NATURAL_BREEDING',.68,.08),(22,1,'NATURAL_BREEDING',.58,.08),(24,1,'NATURAL_BREEDING',.50,.07),
 (3,2,'IVF',.78,.06),(19,2,'IVF',.63,.09),(22,2,'IVF',.54,.09),(24,2,'IVF',.46,.08)
) controls(stage_order,arm_no,arm_type,normal_ratio,abnormal_ratio);

INSERT INTO audit_log (id,table_name,record_id,action,old_values,new_values,operator_id,device_id,occurred_at)
SELECT CONCAT('69000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),'experiment_batch',
 CONCAT('61000000-0000-7000-8000-',LPAD(batch_no::text,12,'0')),'INSERT',NULL,
 json_build_object('source','deterministic mock','format','Batch_ID/Lot/Embryo_ID','batchNo',batch_no)::text,
 CASE operator_name WHEN 'Jan' THEN '20000000-0000-7000-8000-000000000001' ELSE '20000000-0000-7000-8000-000000000002' END,
 'LAB-MOCK-01',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-days_ago+TIME '09:30'
FROM seed_mock_rows;

DO $$
BEGIN
 IF (SELECT COUNT(*) FROM experiment_batch WHERE id LIKE '61000000-%')<>12
 OR (SELECT COUNT(*) FROM embryo WHERE id LIKE '63000000-%')<>(SELECT SUM(activated) FROM seed_mock_rows)
 OR (SELECT COUNT(*) FROM clone_fish WHERE id LIKE '65000000-%')<>(SELECT SUM(fry) FROM seed_mock_rows)
 OR NOT EXISTS(SELECT 1 FROM embryo WHERE embryo_code='12_June_Control_3_1')
 OR NOT EXISTS(SELECT 1 FROM specimen WHERE specimen_code='CL1')
 OR (SELECT experiment_date FROM experiment_batch WHERE batch_code='12_June_Control')<>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date
 OR EXISTS(SELECT 1 FROM embryo_observation observation JOIN embryo ON embryo.id=observation.embryo_id
   WHERE embryo.injection_lot_id='62000000-0000-7000-8000-000000000012'
     AND observation.stage_definition_id<>'01900001-0000-7000-8000-000000000001')
 OR EXISTS(SELECT 1 FROM embryo WHERE id LIKE '63000000-%'
   AND injection_lot_id<>'62000000-0000-7000-8000-000000000012' AND exit_reason IS NULL) THEN
  RAISE EXCEPTION 'current mock seed verification failed';
 END IF;
END $$;

COMMIT;
