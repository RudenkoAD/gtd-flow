#!/usr/bin/env node
/**
 * Генератор синтетического vault для ручного перф-теста GTD Flow в реальном
 * Obsidian (ТЗ §12 п.5: джанк старта на больших хранилищах).
 *
 * Использование:
 *   node scripts/gen-test-vault.mjs <папка-назначения> [--files N] [--tasks M]
 *
 * Папка назначения ОБЯЗАТЕЛЬНА (дефолта нет намеренно — чтобы не насыпать
 * файлов в чужое место). Открой её как vault в Obsidian и поставь плагин:
 * .obsidian/plugins/gtd-flow/{main.js,manifest.json,styles.css}.
 *
 * Генерирует:
 *   GTD/Inbox.md            — файл захвата (inboxSources по умолчанию)
 *   GTD/Recurring.md        — каталог шаблонов регулярного ящика
 *   Boards/*.md             — 3 kanban-доски
 *   Projects/*.md           — 3 проекта с цепочками ⛔ и layout
 *   Bulk/bulk-NNN.md        — N файлов × M задач: микс обычных/с датами/с тегами
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// --- аргументы ---

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--")) {
	console.error("Использование: node scripts/gen-test-vault.mjs <папка-назначения> [--files N] [--tasks M]");
	console.error("Папка назначения обязательна. Пример:");
	console.error("  node scripts/gen-test-vault.mjs ../gtd-perf-vault --files 500 --tasks 20");
	process.exit(1);
}
const targetDir = args[0];

function intFlag(name, fallback) {
	const i = args.indexOf(name);
	if (i === -1) return fallback;
	const v = Number.parseInt(args[i + 1] ?? "", 10);
	if (!Number.isFinite(v) || v <= 0) {
		console.error(`Флаг ${name} требует положительное целое, получено: ${args[i + 1]}`);
		process.exit(1);
	}
	return v;
}

const FILES = intFlag("--files", 500);
const TASKS = intFlag("--tasks", 20);

// --- вспомогательное ---

const pad = (n) => String(n).padStart(2, "0");
/** Валидная дата 2026 года: месяц 1–12, день 1–28. */
const isoDate = (seed) => `2026-${pad((seed % 12) + 1)}-${pad((seed % 28) + 1)}`;

function write(relPath, content) {
	const abs = join(targetDir, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

// --- GTD/Inbox.md ---

write(
	"GTD/Inbox.md",
	`# Входящие

- [ ] Позвонить в сервис по поводу машины
- [ ] Купить подарок 📅 ${isoDate(7)}
- [ ] Разобрать фотографии с отпуска 🔽
- [ ] Продлить страховку ⏫ 📅 ${isoDate(11)}
- [ ] Отложена в прошлое (должна быть видна) 🛫 2026-01-05
- [ ] Отложена в будущее (видна только в Отложенных) 🛫 2027-01-05
- [x] Уже сделана ✅ 2026-07-01
`,
);

// --- GTD/Recurring.md: каталог шаблонов ---

write(
	"GTD/Recurring.md",
	`---
gtd-recurring: true
---

# Регулярные

- [ ] Еженедельное ревью #review 🔁 every week on friday 🆔 rev-week
- [ ] Ревью приоритетов #review 🔺 🔁 every month on the last day 🛫 -3d 🆔 rev-prio
- [ ] Оплатить хостинг 🔁 every month on the 1st 📅 +3d 🆔 pay-hosting
- [ ] Бэкап vault 🔁 every 2 weeks on sunday 🆔 backup-vault
- [-] Пауза: продлить парковку 🔁 every 3 months on the 1st 🆔 park-permit
`,
);

// --- Boards: 3 доски ---

const BOARDS = [
	{ file: "Boards/Работа.md", id: "work", name: "Работа" },
	{ file: "Boards/Дом.md", id: "home", name: "Дом" },
	{ file: "Boards/Хобби.md", id: "hobby", name: "Хобби" },
];

for (const [bi, b] of BOARDS.entries()) {
	const lines = [];
	for (let i = 0; i < 8; i++) {
		const col = i < 5 ? "todo" : "doing";
		const status = i % 6 === 5 ? "x" : col === "doing" ? "/" : " ";
		const extra = i % 3 === 0 ? ` 📅 ${isoDate(bi * 7 + i)}` : i % 4 === 1 ? " ⏫" : "";
		lines.push(
			status === "x"
				? `- [x] ${b.name}: закрытая задача ${i} ✅ 2026-07-01`
				: `- [${status}] ${b.name}: задача ${i} #kanban/${b.id}/${col}${extra}`,
		);
	}
	write(
		b.file,
		`---
gtd-board: true
id: ${b.id}
name: ${b.name}
group-by: tag
columns:
  - { id: todo, name: "К работе", match: "#kanban/${b.id}/todo" }
  - { id: doing, name: "В работе", match: "#kanban/${b.id}/doing" }
  - { id: done, name: "Готово", match: "status:done" }
order:
  todo: []
  doing: []
---

# Доска «${b.name}»

${lines.join("\n")}
`,
	);
}

// --- Projects: 3 проекта с цепочками ⛔ ---

const PROJECTS = [
	{ file: "Projects/Ремонт кухни.md", name: "Ремонт кухни", prefix: "kit", n: 6 },
	{ file: "Projects/Переезд блога.md", name: "Переезд блога", prefix: "blog", n: 8 },
	{ file: "Projects/Отпуск.md", name: "Отпуск", prefix: "trip", n: 5 },
];

for (const p of PROJECTS) {
	const ids = Array.from({ length: p.n }, (_, i) => `${p.prefix}-${pad(i)}`);
	const layout = ids.map((id, i) => `  ${id}: { x: ${i * 260}, y: ${(i % 2) * 140 - 70} }`);
	const lines = ids.map((id, i) => {
		// первая задача выполнена → у второй зависимости закрыты, она ready;
		// дальше цепочка + один «ромб» (задача 3 зависит от 1 и 2)
		const deps = i === 0 ? "" : i === 3 ? ` ⛔ ${ids[1]},${ids[2]}` : ` ⛔ ${ids[i - 1]}`;
		const status = i === 0 ? "x" : " ";
		const done = i === 0 ? " ✅ 2026-07-01" : "";
		const defer = i === p.n - 1 ? " 🛫 2027-01-10" : ""; // хвост цепочки — ещё и тикль
		return `- [${status}] ${p.name}: шаг ${i} 🆔 ${id}${deps}${done}${defer}`;
	});
	write(
		p.file,
		`---
gtd-project: true
name: ${p.name}
status: active
layout:
${layout.join("\n")}
---

# ${p.name}

${lines.join("\n")}
`,
	);
}

// --- Bulk: N файлов × M задач ---

for (let f = 0; f < FILES; f++) {
	const lines = [`# Bulk ${f}`, ""];
	for (let i = 0; i < TASKS; i++) {
		const status = i % 7 === 0 ? "x" : i % 11 === 3 ? "/" : " ";
		const parts = [`- [${status}] Массовая задача ${f}-${i}`];
		if (i % 4 === 1) parts.push(i % 8 === 1 ? "⏫" : "🔽");
		if (i % 5 === 0) parts.push(`📅 ${isoDate(f + i)}`);
		if (i % 6 === 2) parts.push(i % 12 === 2 ? "🛫 2027-02-01" : "🛫 2026-01-01");
		if (i % 9 === 4) parts.push("#waiting");
		if (status === "x") parts.push("✅ 2026-07-01");
		lines.push(parts.join(" "));
	}
	write(`Bulk/bulk-${String(f).padStart(3, "0")}.md`, lines.join("\n") + "\n");
}

const total = FILES * TASKS + BOARDS.length * 8 + PROJECTS.reduce((s, p) => s + p.n, 0) + 12;
console.log(`Готово: ${targetDir}`);
console.log(`  Bulk: ${FILES} файлов × ${TASKS} задач, доски: ${BOARDS.length}, проекты: ${PROJECTS.length}`);
console.log(`  Всего ~${total} задач. Откройте папку как vault и включите GTD Flow.`);
