DO $$
DECLARE
  archive_has_rows boolean;
BEGIN
  IF to_regclass('public.queue_entries_unmapped_archive') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.queue_entries_unmapped_archive LIMIT 1)'
    INTO archive_has_rows;

  IF archive_has_rows THEN
    RAISE EXCEPTION 'queue_entries_unmapped_archive is not empty; inspect rows before dropping the table';
  END IF;

  DROP TABLE public.queue_entries_unmapped_archive;
END $$;
