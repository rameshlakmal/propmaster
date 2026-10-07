// Renders demo/gif/propmaster-demo.gif with VHS in Docker: npm run gif
// Needs the demo database (npm run db:up) and a build (npm run build).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('dist/cli.js')) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const run = (args: string[]) => execFileSync('docker', args, { stdio: 'inherit' });
run(['build', '-q', '-t', 'propmaster-vhs', 'demo/gif']);
// Capped, so headless Chromium and ffmpeg can't starve Docker Desktop's VM (it froze twice without this).
run(['run', '--rm', '--cpus', '2', '--memory', '2g', '--network', 'propmaster_default', '-v', `${process.cwd()}:/app`, '-w', '/app', 'propmaster-vhs', 'demo/gif/demo.tape']);
console.log('Wrote demo/gif/propmaster-demo.gif');
