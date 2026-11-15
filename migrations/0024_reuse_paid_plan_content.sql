ALTER TABLE reuse_applications
ADD COLUMN uses_paid_plan_content INTEGER NOT NULL DEFAULT 0
CHECK (uses_paid_plan_content IN (0, 1));
