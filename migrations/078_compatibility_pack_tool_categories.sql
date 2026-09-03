-- Register categories used by bundled compatibility packs.
-- INSERT OR IGNORE keeps this safe for deployments that already added any of
-- these categories through an administrator or a later seed.
INSERT OR IGNORE INTO tool_categories (name, icon, sort_order) VALUES
  ('Reasoning', 'fa-lightbulb', 20),
  ('Verification', 'fa-check-circle', 21),
  ('Infrastructure', 'fa-server', 22),
  ('Documentation', 'fa-book', 23),
  ('Network Services', 'fa-network-wired', 24),
  ('Linux Systems', 'fa-linux', 25),
  ('Operations', 'fa-cogs', 26),
  ('Backup and DR', 'fa-life-ring', 27),
  ('Observability', 'fa-chart-line', 28),
  ('Infrastructure & Homelab', 'fa-home', 29),
  ('Compute', 'fa-microchip', 30);
