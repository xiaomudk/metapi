CREATE TABLE IF NOT EXISTS `admin_snapshots` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `namespace` TEXT NOT NULL, `snapshot_key` JSON NOT NULL, `payload` TEXT NOT NULL, `generated_at` VARCHAR(191) NOT NULL, `expires_at` VARCHAR(191) NOT NULL, `stale_until` VARCHAR(191) NOT NULL, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), `updated_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')));
CREATE UNIQUE INDEX `admin_snapshots_namespace_key_unique` ON `admin_snapshots` (`namespace`(191), `snapshot_key`);
CREATE INDEX `admin_snapshots_expires_at_idx` ON `admin_snapshots` (`expires_at`);
CREATE INDEX `admin_snapshots_stale_until_idx` ON `admin_snapshots` (`stale_until`);
