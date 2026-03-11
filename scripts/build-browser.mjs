import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { minify } from 'terser';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const browser = process.argv[2];
const isReleaseBuild = process.argv.includes('--release');
const shouldMinify = isReleaseBuild && !process.argv.includes('--no-minify');
const shouldObfuscate = isReleaseBuild && !process.argv.includes('--no-obfuscate');
const OBFUSCATION_TARGETS = new Set([
    'js/content.js',
    'js/editor.js',
    'js/markdown-renderer.js',
    'js/text-selection-helper.js',
    'js/cropper.js',
    'js/changelog.js'
]);

if (!['firefox', 'chrome'].includes(browser)) {
    console.error('Usage: node scripts/build-browser.mjs <firefox|chrome> [--release] [--no-minify] [--no-obfuscate]');
    process.exit(1);
}

const distDir = path.join(rootDir, 'dist', browser);
const baseManifestPath = path.join(rootDir, 'manifest.base.json');
const browserManifestPath = path.join(rootDir, `manifest.${browser}.json`);

await fs.rm(distDir, { recursive: true, force: true });
await copyWorkspace(rootDir, distDir);

const baseManifest = JSON.parse(await fs.readFile(baseManifestPath, 'utf8'));
const browserManifest = JSON.parse(await fs.readFile(browserManifestPath, 'utf8'));
const mergedManifest = deepMerge(baseManifest, browserManifest);

await fs.writeFile(
    path.join(distDir, 'manifest.json'),
    `${JSON.stringify(mergedManifest, null, 2)}\n`,
    'utf8'
);

let minifiedCount = 0;
let obfuscatedCount = 0;
if (isReleaseBuild) {
    if (shouldMinify) {
        minifiedCount = await minifyDistScripts(distDir);
    }
    if (shouldObfuscate) {
        obfuscatedCount = await obfuscateDistScripts(distDir);
    }
}

const buildLabel = isReleaseBuild ? `${browser} release` : browser;
const buildSuffix = isReleaseBuild
    ? ` (minify: ${shouldMinify ? `on, ${minifiedCount} scripts` : 'off'}, obfuscate: ${shouldObfuscate ? `on, ${obfuscatedCount} scripts` : 'off'})`
    : '';
console.log(
    `Built ${buildLabel} extension into ${distDir}${buildSuffix}`
);

async function copyWorkspace(sourceDir, targetDir) {
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        if (shouldSkip(entry.name)) {
            continue;
        }

        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            await copyWorkspace(sourcePath, targetPath);
            continue;
        }

        await fs.copyFile(sourcePath, targetPath);
    }
}

function shouldSkip(name) {
    return [
        '.git',
        'dist',
        'node_modules',
        'manifest.base.json',
        'manifest.firefox.json',
        'manifest.chrome.json'
    ].includes(name);
}

function deepMerge(base, override) {
    if (Array.isArray(base) && Array.isArray(override)) {
        return Array.from(new Set([...base, ...override]));
    }

    if (Array.isArray(base) || Array.isArray(override)) {
        return override;
    }

    if (isObject(base) && isObject(override)) {
        const merged = { ...base };
        for (const [key, value] of Object.entries(override)) {
            merged[key] = key in merged ? deepMerge(merged[key], value) : value;
        }
        return merged;
    }

    return override;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function minifyDistScripts(targetDir) {
    const scriptsDir = path.join(targetDir, 'js');
    const files = await collectMinifiableScripts(scriptsDir, targetDir);

    for (const filePath of files) {
        const input = await fs.readFile(filePath, 'utf8');
        const result = await minify(input, createTerserOptions(input));

        if (!result.code) {
            throw new Error(`Terser produced empty output for ${path.relative(targetDir, filePath)}`);
        }

        await fs.writeFile(filePath, result.code, 'utf8');
    }

    return files.length;
}

async function obfuscateDistScripts(targetDir) {
    let obfuscatedFiles = 0;

    for (const relativePath of OBFUSCATION_TARGETS) {
        const absolutePath = path.join(targetDir, relativePath);

        try {
            await fs.access(absolutePath);
        } catch {
            continue;
        }

        const sourceCode = await fs.readFile(absolutePath, 'utf8');
        if (/(^|\n)\s*(import|export)\s/m.test(sourceCode)) {
            continue;
        }

        const result = JavaScriptObfuscator.obfuscate(sourceCode, createObfuscatorOptions());
        await fs.writeFile(absolutePath, result.getObfuscatedCode(), 'utf8');
        obfuscatedFiles += 1;
    }

    return obfuscatedFiles;
}

async function collectMinifiableScripts(directory, rootForRelativePath) {
    const files = [];
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const relativePath = path.relative(rootForRelativePath, entryPath).split(path.sep).join('/');

        if (entry.isDirectory()) {
            if (relativePath === 'js/lib' || relativePath.startsWith('js/lib/')) {
                continue;
            }

            files.push(...await collectMinifiableScripts(entryPath, rootForRelativePath));
            continue;
        }

        if (!relativePath.startsWith('js/')) {
            continue;
        }

        if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) {
            continue;
        }

        if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.mjs')) {
            continue;
        }

        files.push(entryPath);
    }

    return files;
}

function createTerserOptions(sourceCode) {
    const isModuleScript = /(^|\n)\s*(import|export)\s/m.test(sourceCode);

    return {
        ecma: 2020,
        module: isModuleScript,
        compress: {
            passes: 2,
            drop_console: false
        },
        mangle: {
            safari10: true
        },
        format: {
            comments: false
        }
    };
}

function createObfuscatorOptions() {
    return {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        selfDefending: false,
        simplify: true,
        splitStrings: false,
        stringArray: false,
        transformObjectKeys: false,
        unicodeEscapeSequence: false
    };
}
