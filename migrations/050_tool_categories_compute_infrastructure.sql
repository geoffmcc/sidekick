-- Add the Compute and Infrastructure tool categories.
--
-- The dashboard groups tools by tool_category_map -> tool_categories. The
-- category rows were seeded once in 002_tool_registry.sql and never included a
-- home for the compute/inference subsystem or for virtualization/host infra, so
-- every compute_* tool (and the Proxmox pack's tools, which declare
-- "Infrastructure") fell through the sync's "category must already exist" guard
-- and showed up under "Other". Adding the rows lets the startup registry sync
-- map those tools to a real category.
--
-- Idempotent (INSERT OR IGNORE) and safe on both fresh and existing databases;
-- tool_categories is created earlier in 002.
INSERT OR IGNORE INTO tool_categories (name, icon, sort_order) VALUES
  ('Compute', 'fa-microchip', 20),
  ('Infrastructure', 'fa-server', 21);
