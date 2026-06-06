import { createLogger, format, transports } from 'winston';
import 'dotenv/config';

const { combine, timestamp, colorize, printf, json, errors } = format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, ...meta }) => {
    const extra = Object.keys(meta).length
      ? ' ' + JSON.stringify(meta, null, 0)
      : '';
    return `${timestamp} ${level}: ${message}${extra}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

export const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new transports.Console(),
  ],
});

// Helper structuré
export const logIngestion = (documentId, event, data = {}) => {
  logger.info(event, { documentId, ...data, context: 'ingestion' });
};
