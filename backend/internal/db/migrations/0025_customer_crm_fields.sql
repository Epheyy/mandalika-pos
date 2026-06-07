-- 0025_customer_crm_fields.sql
-- SP-CRM-1: richer customer fields. Additive + nullable: safe for POS sync
-- (customers array) and the offline customer_create outbox path.
ALTER TABLE customers ADD COLUMN birthday    DATE;
ALTER TABLE customers ADD COLUMN anniversary DATE;
ALTER TABLE customers ADD COLUMN notes       TEXT;
