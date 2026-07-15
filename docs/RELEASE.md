# Чек-лист релиза GTD Flow (community-плагин Obsidian)

По ТЗ §10 + [требования каталога](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin).
Статусы «проверено» — фактический греп кодовой базы от 2026-07-15 (см. раздел «Гигиена ревью»).

## 1. Манифест (`manifest.json`)

- [x] `id: "gtd-flow"` — строчные, без пробелов, не содержит «obsidian»
- [x] `name: "GTD Flow"` — без слов «Obsidian» и «plugin»
- [x] `version: "0.1.0"` — semver `x.y.z`, совпадает с `package.json`
- [x] `minAppVersion: "1.7.2"` — минимум для Deferred Views (ТЗ §4)
- [x] `isDesktopOnly: false` — мобильные поддержаны (фолбэки: меню вместо drag, граф списком)
- [x] `description` — по-английски, без «Obsidian»/«plugin», < 250 символов
- [x] `author` заполнен
- [ ] `authorUrl` / `fundingUrl` — опциональны, добавить по желанию до сабмита

## 2. Версии

- [x] `versions.json`: `{ "0.1.0": "1.7.2" }` — карта «версия плагина → minAppVersion»
- [x] `npm version <x.y.z>` прогоняет `version-bump.mjs`: синхронизирует `manifest.json` и `versions.json`
- [ ] Перед тегом: номер версии поднят во всех трёх местах (package.json / manifest.json / versions.json)

## 3. Гейты перед сборкой артефактов

- [ ] `node scripts/check-core-purity.mjs` — ноль импортов `obsidian` в `src/core` и `src/services`
- [ ] `npx vitest run` — весь набор зелёный (873+ тестов, включая перф-смоук)
- [ ] `npx tsc -noEmit -skipLibCheck` — чисто
- [ ] `node esbuild.config.mjs production` — production-бандл без ошибок
  (всё вместе: `npm run build` = purity + tsc + esbuild production)

## 4. Три артефакта релиза

- [ ] `main.js` — production-сборка (bundle; `obsidian`, `electron`, `@codemirror/*`, `@lezer/*` — external)
- [ ] `manifest.json`
- [ ] `styles.css`
- [ ] Артефакты приложены к GitHub-релизу **отдельными файлами** (не внутри zip)
- [ ] `manifest.json` лежит также в **корне репозитория** (требование BRAT и каталога)

## 5. GitHub release

- [ ] Тег релиза **точно равен** `version` из манифеста: `0.1.0`, **без префикса `v`**
- [ ] Release notes: что нового, известные ограничения
- [ ] Релиз опубликован (не draft)

## 6. Сабмит в каталог

- [ ] Форк `obsidianmd/obsidian-releases`, в `community-plugins.json` добавлена запись
      `{ "id": "gtd-flow", "name": "GTD Flow", "author": …, "description": …, "repo": "<owner>/<repo>" }`
      (в конец списка, не по алфавиту)
- [ ] PR по шаблону; проверки бота зелёные; ответить на замечания ревью
- [ ] ⚠️ **LICENSE-файла в репозитории нет** — `package.json` заявляет MIT, но файл `LICENSE`
      обязателен для сабмита. Добавить до PR.
- [ ] ⚠️ README сейчас на русском. Каталог не запрещает, но для ревью и пользователей
      желательна английская версия (или двуязычная) — решить до сабмита.

## 7. Гигиена ревью — фактический статус (греп src/ от 2026-07-15)

| Проверка | Статус | Детали |
|---|---|---|
| `innerHTML` / `outerHTML` / `insertAdjacentHTML` | ✅ 0 вхождений в `src/` | В бандле `main.js` — 3 вхождения **из зависимостей**: рантайм Svelte (создание шаблонов через detached `<template>.innerHTML` со статическими строками компилятора) и d3-selection (внутри `@xyflow/svelte`). Собственного кода с innerHTML нет; DOM строится через `createEl`/`createDiv`/Svelte. |
| `instanceof` вместо cast | ✅ | `openTask.ts`: `file instanceof TFile`, `leaf.view instanceof MarkdownView`. Исключение осознанное: `MetadataAdapter.isMarkdownFile` — структурная проверка `extension === "md"` вместо `instanceof TFile`, т.к. импорт `obsidian` там строго type-only (файл гоняется в node-тестах); задокументировано комментарием в коде. |
| `vault.configDir` / жёсткие пути `.obsidian` | ✅ | Плагин вообще не обращается к каталогу конфига: греп `configDir` и `\.obsidian` по `src/` — 0 вхождений. |
| `isDesktopOnly: false` | ✅ | Подтверждено манифестом; мобильные фолбэки реализованы (ТЗ §8 слой 3). |
| Всё через `register*` | ✅ | `registerView` / `registerEvent` / `registerInterval` / `addCommand` везде. Исключение осознанное: `DndService` вешает pointer-листенеры руками на конкретное окно (pop-out имеет свой DOM) и снимает их через `plugin.register(() => …)` — утечек нет, причина задокументирована в коде. |
| Deferred Views (≥1.7.2) | ✅ | Виды активируются только через `setViewState`/`revealLeaf`; кастов `leaf.view as <наш вид>` на чужих leaf нет (греп `.view` — единственное обращение через `instanceof MarkdownView`). |
| `console.log` в продакшн-коде | ✅ 0 | Только `console.error` на реальных сбоях (прерванный скан, сбой первичной сборки). |
| Сетевые запросы | ✅ 0 | `fetch` / `XMLHttpRequest` / `requestUrl` — 0 вхождений: плагин полностью офлайн. |
| Небезопасные касты | ⚠️ приемлемо | В продакшн-коде `as unknown as` — типизационный шим Svelte 5 (`Component<any>` в обёртках видов), недокументированный флаг `metadataCache.initialized` (задокументирован комментарием и обёрнут в проверку) и `app.dragManager` под feature-detect. Остальные — в тестах. |
| Глобальный `app` | ✅ | Только `this.app` / инжектированный `plugin.app`. |

## 8. После публикации

- [ ] Проверить установку с нуля через каталог (или BRAT до принятия PR)
- [ ] Smoke-тест на мобильном устройстве (iOS/Android) — установка и открытие видов
- [ ] Тег `0.1.1+`: далее релизы — только через `npm version` + новый GitHub release
