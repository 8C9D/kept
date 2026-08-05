-- updated_at is maintained here, in the database, so its freshness cannot
-- depend on every future handler remembering to set it (spec §5).
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER receipts_set_updated_at
BEFORE UPDATE ON receipts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
