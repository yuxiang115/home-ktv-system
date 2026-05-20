CREATE UNIQUE INDEX IF NOT EXISTS source_records_ktv_index_asset_uq
  ON source_records(provider, provider_item_id)
  WHERE provider = 'ktv-index' AND provider_item_id IS NOT NULL;
