import 'dotenv/config';
import { migrate } from '../src/migrate';

await migrate();
console.log('✅ Schéma appliqué.');
