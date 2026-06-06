import Redis from 'ioredis';
import 'dotenv/config';

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // requis par BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

export const QUEUES = {
  INGESTION:  'rag-ingestion',
  EMBEDDING:  'rag-embedding',
  CLEANUP:    'rag-cleanup',
};

export const JOB_OPTIONS = {
  attempts: parseInt(process.env.MAX_RETRIES || '3'),
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: { age: 86400, count: 100 },
  removeOnFail:     { count: 50 },
};
