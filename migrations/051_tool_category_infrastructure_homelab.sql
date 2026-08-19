-- Add the category used by the network and firewall capability pack.
-- Keep this distinct from the broader Infrastructure category used by
-- compute, container, and server-management tools.
INSERT OR IGNORE INTO tool_categories (name, icon, sort_order) VALUES
  ('Infrastructure & Homelab', 'fa-network-wired', 22);
