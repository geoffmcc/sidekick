-- 077: Normalize legacy packet aliases into the Handoff v3 receiver contract.
-- This preserves historical content and does not invent checkpoints or evidence.

UPDATE memory_handoffs SET packet_json = json_set(packet_json, '$.status', CASE
  WHEN json_extract(packet_json, '$.status') IS NOT NULL THEN json_extract(packet_json, '$.status')
  WHEN json_extract(packet_json, '$.state') IN ('active', 'blocked', 'ready', 'completed', 'abandoned') THEN json_extract(packet_json, '$.state')
  ELSE 'active' END), schema_version = 3
WHERE packet_json IS NOT NULL AND json_valid(packet_json);

UPDATE memory_handoffs SET packet_json = json_set(packet_json, '$.next_step', CASE
  WHEN json_extract(packet_json, '$.next_step') IS NOT NULL THEN json_extract(packet_json, '$.next_step')
  WHEN json_type(packet_json, '$.next_steps[0]') = 'text' THEN json_extract(packet_json, '$.next_steps[0]')
  ELSE 'Review the handoff and define the next safe action' END)
WHERE packet_json IS NOT NULL AND json_valid(packet_json);

UPDATE memory_handoffs SET packet_json = json_set(packet_json, '$.completed_steps', CASE
  WHEN json_type(packet_json, '$.completed_steps') = 'array' THEN json_extract(packet_json, '$.completed_steps')
  WHEN json_type(packet_json, '$.work_completed') = 'array' THEN json_extract(packet_json, '$.work_completed')
  ELSE json('[]') END)
WHERE packet_json IS NOT NULL AND json_valid(packet_json);

UPDATE memory_handoffs SET packet_json = json_set(packet_json, '$.evidence', CASE
  WHEN json_type(packet_json, '$.evidence') = 'array' THEN json_extract(packet_json, '$.evidence')
  WHEN json_type(packet_json, '$.tests_and_evidence') = 'array' THEN json_extract(packet_json, '$.tests_and_evidence')
  ELSE json('[]') END)
WHERE packet_json IS NOT NULL AND json_valid(packet_json);

UPDATE memory_handoffs SET packet_json = json_set(packet_json, '$.acceptance_criteria', CASE
  WHEN json_type(packet_json, '$.acceptance_criteria') = 'array' THEN json_extract(packet_json, '$.acceptance_criteria')
  ELSE json('[]') END)
WHERE packet_json IS NOT NULL AND json_valid(packet_json);

INSERT OR REPLACE INTO meta (key, value) VALUES ('handoff_schema_version', '3');
