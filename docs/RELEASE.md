# Чек-лист релиза GTD Flow

Этот документ намеренно не содержит конкретного номера версии или числа тестов:
источники истины проверяются автоматически перед каждым релизом.

## 1. Подготовка версии

- [ ] Выполнить `npm version <x.y.z>`. Скрипт `version-bump.mjs` синхронизирует
      `package.json`, `manifest.json` и `versions.json`.
- [ ] Проверить `git diff` и release notes.
- [ ] Проверить [breaking AI Inbox MVP release notes](BREAKING_AI_INBOX_MVP.md)
      и убедиться, что D1/D2 остаются явными выборами каждого migration run.
- [ ] Выполнить `npm run verify:release` (или полный `npm run verify`, который также
      проверяет собранные артефакты).
- [ ] Опубликовать тег, созданный `npm version` (например `v0.12.0`). Контракт также
      принимает эквивалентный тег без `v`; после нормализации он должен точно совпасть
      с версией в `package.json`.

`scripts/verify-release.mjs` блокирует публикацию, если:

- тег не является текущей версией пакета;
- `package.json` и `manifest.json` расходятся;
- `versions.json` не содержит правильную пару
  `version → minAppVersion`;
- отсутствует контракт Node runtime или приватность npm-пакета.

Добавьте `--artifacts`, чтобы также проверить обязательные release-файлы. Полный
`npm run verify` всегда использует этот режим перед CI/release.

## 2. Локальные гейты

Перед тегом:

```bash
npm ci
npm run verify
```

`verify` выполняет:

1. ESLint и проверку форматирования Prettier;
2. AST-проверку границ `core` / `services` / MCP / widget;
3. весь набор Vitest с обязательными порогами покрытия для `core`, `services` и MCP;
4. compiler/a11y-smoke всех исходных `.svelte` и полный `svelte-check`;
5. mounted browser-тесты реальных Svelte-компонентов в Chromium с axe;
6. TypeScript без emit;
7. production-сборку Obsidian-плагина, MCP и widget core;
8. бюджеты размера бандлов;
9. проверку release contract и наличие всех публикуемых файлов.

Перед первым локальным browser-прогоном выполните `npx playwright install chromium`;
CI устанавливает Chromium автоматически. Не обходите `verify` отдельным вызовом
`esbuild`.

## 3. Автоматический release pipeline

`.github/workflows/release.yml` разделён на две зоны доверия:

1. `build` имеет только `contents: read`, устанавливает зависимости, выполняет все
   тесты и создаёт проверенный artifact bundle;
2. `publish` получает `contents: write`, но не checkout-ит и не исполняет код
   зависимостей — только проверяет SHA-256 и публикует готовый bundle.

Все сторонние GitHub Actions закреплены на полных commit SHA.
Любой несовпадающий или невалидный тег завершает `build` ошибкой до публикации.

## 4. Контракт артефактов

GitHub release публикует отдельными файлами:

| Файл                                     | Назначение                                                 |
| ---------------------------------------- | ---------------------------------------------------------- |
| `main.js`, `manifest.json`, `styles.css` | Установка Obsidian-плагина / BRAT                          |
| `mcp-server.js`                          | Опциональный standalone MCP-сервер                         |
| `widget-core.js`                         | Версионированное ядро для внешних QuickJS/Android-виджетов |
| `LICENSE`                                | Лицензия проекта                                           |
| `SHA256SUMS`                             | Проверка целостности всех файлов выше                      |

`manifest.json` и `versions.json` остаются в корне репозитория, как требует
экосистема Obsidian. `widget-core.js` не нужно копировать в папку Obsidian-плагина.
`manifest.json` для этого breaking release содержит `isDesktopOnly: true`.

Для локальной проверки полного набора:

```bash
npm run build
npm run prepare:release -- --tag "$(node -p "require('./package.json').version")"
cd dist/release
sha256sum --check SHA256SUMS
```

## 5. Проверки совместимости

- [ ] CI зелёный на минимальном поддерживаемом Node и актуальном LTS.
- [ ] Компиляция использует API, доступные в `manifest.minAppVersion`.
- [ ] Smoke-тест чистой установки Obsidian на минимальной поддерживаемой версии.
- [ ] Smoke-тест последней Obsidian на desktop.
- [ ] Проверить, что mobile не заявлен и не загружается как поддерживаемая
      поверхность (`isDesktopOnly: true`).
- [ ] MCP запускается заявленным минимальным Node и возвращает правильную
      `serverInfo.version`.
- [ ] Проверить breaking MCP contract: нет `namespace` входов/выходов; есть
      `scope`, `duration_minutes`, `cognitive_intensity`,
      `emotional_intensity` и `physical_intensity`.
- [ ] Проверить widget-core v2: scope-filter/metadata и camelCase edits
      соответствуют README.

## 6. Ручная проверка продукта

Выполнить `docs/VERIFY.md` на **новом** тестовом хранилище. Генератор теперь
отказывается использовать существующую папку; `--force` разрешён только для ранее
созданного им vault с маркером `.gtd-flow-test-vault`. Не направляйте его в реальное
хранилище.

Особенно проверить:

- операции перемещения и архивации;
- восстановление после искусственно вызванных write errors;
- календарные подписки, таймаут и удаление во время активной синхронизации;
- клавиатурную работу календаря;
- pop-out на desktop;
- unified inbox/scope migration: dry-run, apply, interrupted resume and rollback;
- AI setup, reconnect-after-restart behavior and explicit queue retry;
- отсутствие неожиданных изменений соседних строк/frontmatter.

## 7. Сетевое и приватное поведение

Плагин не является полностью офлайн: внешние календарные подписки выполняют
`requestUrl` по URL, явно заданным пользователем. Проверить:

- отсутствие сетевых запросов без настроенной подписки;
- отсутствие URL/содержимого приватных календарей в логах;
- корректные лимиты размера, времени и числа событий;
- удаление или миграцию управляемых mirror-файлов при изменении настроек.

AI также выполняет сеть только после явной команды/сообщения. Перед релизом
проверить, что OpenRouter OAuth использует PKCE/S256 и `openrouter/free`, без
платного fallback; policy `require-zdr` закрывает запрос при отсутствии
совместимого маршрута; OAuth key не появляется в vault, `.gtd-flow`, `data.json`,
логах или экспортируемой истории. В текущем MVP credential memory-only, поэтому
после перезапуска Desktop требуется reconnect.

MCP пишет прямо в Markdown-файлы. Перед релизом прогнать параллельные write-тесты,
проверку conflict detection, сохранение file mode и fail-closed поведение для
невалидных YAML/settings.

## 8. Сабмит и пост-релиз

- [ ] Репозиторий содержит `LICENSE` и актуальный README.
- [ ] Для каталога Obsidian запись в `community-plugins.json` соответствует
      `manifest.json`.
- [ ] Release опубликован, не draft.
- [ ] Установка через BRAT проверена с нуля.
- [ ] `SHA256SUMS` сходится с опубликованными файлами.
- [ ] Известные ограничения и миграции перечислены в release notes.
- [ ] Release notes явно называют breaking переход с runtime namespaces на
      unified inbox + task scopes и дают путь к dry-run/apply/resume/rollback.
- [ ] После публикации отслеживать CI dependency audit и пользовательские ошибки
      синхронизации/writeback.
