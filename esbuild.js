// Bundle the extension host code (src/extension.ts + its node_modules) into a
// single out/extension.js so the VSIX ships one file instead of the whole
// @grpc dependency tree. Only the extension's Node code is bundled — the
// webview assets (media/*), the vendored proto (loaded from disk at runtime),
// and bin/simhelper are separate shipped files, untouched by this.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild
	.build({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: 'out/extension.js',
		// Provided by the VS Code host; never bundle it.
		external: ['vscode'],
		minify: production,
		sourcemap: !production,
		logLevel: 'info',
	})
	.catch(() => process.exit(1));
