ALTER TABLE playback_sessions
  ADD COLUMN IF NOT EXISTS volume_percent integer NOT NULL DEFAULT 100 CHECK (volume_percent >= 0 AND volume_percent <= 100);

ALTER TABLE control_commands
  DROP CONSTRAINT IF EXISTS control_commands_command_type_check;

ALTER TABLE control_commands
  ADD CONSTRAINT control_commands_command_type_check
  CHECK (command_type IN (
    'add-queue-entry',
    'delete-queue-entry',
    'undo-delete-queue-entry',
    'promote-queue-entry',
    'skip-current',
    'switch-vocal-mode',
    'set-volume',
    'player-ended'
  ));
