/**
 * Сборка JS-бандла ядра для Android-виджетов: src/widget/widgetCore.ts → widget-core.js.
 *
 * Формат IIFE (globalName GtdWidgetCore) — бандл грузится во ВСТРАИВАЕМЫЙ движок
 * QuickJS как один скрипт, экспорт достаётся как глобал GtdWidgetCore. platform
 * "neutral" + target es2020: НИКАКИХ node built-ins и браузерных API — если что-то
 * их импортнёт, сборка упадёт (external не задаём НАМЕРЕННО, чтобы ловить протечки).
 * Комментарии esbuild вырезает, поэтому пост-проверка на require/process сканирует
 * именно РАНТАЙМ-код. Ни минификации, ни sourcemap — бандл читаем для аудита.
 */
import esbuild from "esbuild";
import { readFileSync } from "fs";

const OUTFILE = "widget-core.js";

const banner = `/*
GENERATED/BUNDLED FILE BY ESBUILD — GTD Flow widget core (QuickJS).
Source: src/widget (see the plugin's GitHub repository).
No node/DOM/npm runtime deps: pure core + services with input-provided files/time.
*/`;

await esbuild.build({
	banner: { js: banner },
	entryPoints: ["src/widget/widgetCore.ts"],
	bundle: true,
	platform: "neutral",
	format: "iife",
	globalName: "GtdWidgetCore",
	target: "es2020",
	outfile: OUTFILE,
	logLevel: "info",
	sourcemap: false,
	minify: false,
	treeShaking: true,
});

// Пост-проверка чистоты бандла для встраиваемого движка: рантайм не должен нести
// node-примитивы. esbuild уже вырезал комментарии, поэтому совпадение — реальный код.
const code = readFileSync(new URL(`./${OUTFILE}`, import.meta.url), "utf8");
const FORBIDDEN = [
	/\brequire\s*\(/, // CJS require
	/\b__require\b/, // esbuild-шим require для внешних CJS
	/\bprocess\b/, // глобал process (env/argv/…)
	/\bmodule\.exports\b/, // CJS-экспорт
	/\bnode:/, // node:-протокол импортов
];
const hits = FORBIDDEN.filter((re) => re.test(code)).map((re) => re.source);
if (hits.length > 0) {
	console.error(`widget-core purity violated — bundle contains: ${hits.join(", ")}`);
	process.exit(1);
}
console.log(`widget-core bundle OK (${OUTFILE}, ${code.length} bytes)`);
