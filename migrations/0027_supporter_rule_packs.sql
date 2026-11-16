-- New add-on: +3 notification rules per 200 JPY monthly pack.
-- Old credit-funded signups retain a zero rule-pack quantity.
ALTER TABLE supporter_credit_signups
 ADD COLUMN rule_packs INTEGER NOT NULL DEFAULT 0 CHECK(rule_packs BETWEEN 0 AND 5);
