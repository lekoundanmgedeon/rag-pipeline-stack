import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max:             parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '10000'),
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Test de connexion au démarrage
export async function checkDbConnection() {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT version()');
  client.release();
  return rows[0].version;
}

export default pool;
