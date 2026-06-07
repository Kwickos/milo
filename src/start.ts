// Point d'entrée Railway : par défaut ce process fait tourner le webhook ET le worker
// dans le même process (simple et suffisant à petite échelle).
// MILO_ROLE permet de séparer en 2 services plus tard (web | worker).
export {};

const role = process.env.MILO_ROLE ?? 'all';

if (role === 'all' || role === 'web') {
  const { migrate } = await import('./migrate');
  await migrate(); // applique le schéma (idempotent) avant de servir
  await import('./web');
}

if (role === 'all' || role === 'worker') {
  await import('./worker');
}
