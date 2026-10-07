// Renders demo/gif/propmaster-demo.gif with VHS in Docker: npm run gif
// Needs the demo database (npm run db:up) and a build (npm run build).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

if (!existsSync('dist/cli.js')) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const docker = (args: string[]) => execFileSync('docker', args, { stdio: 'inherit' });
// Capped, so the renderer can't starve Docker Desktop's VM (uncapped, it froze Docker twice).
const container = ['run', '--rm', '--cpus', '2', '--memory', '2g', '-v', `${process.cwd()}:/app`, '-w', '/app'];

docker(['build', '-q', '-t', 'propmaster-vhs', 'demo/gif']);

// 1. VHS records the tape to an MP4, which is encoded as it streams.
docker([...container, '--network', 'propmaster_default', 'propmaster-vhs', 'demo/gif/demo.tape']);

// 2. ffmpeg turns it into a GIF in two passes (palette, then frames), so it never holds the whole video
//    in memory. VHS's own GIF output does, which needs about 4 GB for this demo.
const vf = 'fps=12,scale=1100:-1:flags=lanczos';
const ffmpeg = (args: string) => docker([...container, '--entrypoint', 'sh', 'propmaster-vhs', '-c', `ffmpeg -v error -y ${args}`]);
ffmpeg(`-i demo/gif/propmaster-demo.mp4 -vf "${vf},palettegen=stats_mode=diff" demo/gif/palette.png`);
ffmpeg(`-i demo/gif/propmaster-demo.mp4 -i demo/gif/palette.png -lavfi "${vf} [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle" demo/gif/propmaster-demo.gif`);

rmSync('demo/gif/propmaster-demo.mp4', { force: true });
rmSync('demo/gif/palette.png', { force: true });
console.log('Wrote demo/gif/propmaster-demo.gif');
