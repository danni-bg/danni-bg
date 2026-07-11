-- 023_org_profile.sql — organization profile (spec 067): a public-ish identity for an org — a contact
-- email, a description, and a picture (a resized data: URL, same shape as users.avatar_url). Additive
-- nullable columns; every existing org keeps null (no profile) with no behavior change.
ALTER TABLE tenants ADD COLUMN contact_email TEXT;
ALTER TABLE tenants ADD COLUMN description TEXT;
ALTER TABLE tenants ADD COLUMN avatar_url TEXT;
