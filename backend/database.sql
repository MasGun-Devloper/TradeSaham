-- StockDSS v3.0 — Database Schema
-- Jalankan: mysql -u root -p < database.sql

CREATE DATABASE IF NOT EXISTS stockdss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE stockdss;

CREATE TABLE IF NOT EXISTS analysis_history (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  symbol         VARCHAR(20)  NOT NULL,
  company_name   VARCHAR(200) DEFAULT NULL,
  price          DECIMAL(15,2) DEFAULT NULL,
  score          INT          NOT NULL,
  recommendation VARCHAR(20)  NOT NULL,
  analyzed_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol (symbol),
  INDEX idx_analyzed_at (analyzed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS watchlist (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  symbol     VARCHAR(20) NOT NULL,
  added_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  note       TEXT DEFAULT NULL,
  UNIQUE KEY unique_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Contoh data watchlist default
INSERT IGNORE INTO watchlist (symbol) VALUES
  ('BBCA'), ('BBRI'), ('BMRI'), ('TLKM'), ('ASII'), ('UNVR'), ('GOTO'), ('BRIS'), ('ITMG');
