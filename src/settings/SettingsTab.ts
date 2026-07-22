/**
 * Вкладка настроек (ТЗ §9). Каждое изменение — мутация plugin.settings +
 * saveSettings. Числовые поля: валидное значение пишется сразу, мусор
 * не пишется вовсе и откатывается к последнему сохранённому на blur.
 */
import { PluginSettingTab, Setting, type App } from "obsidian";
import type GtdFlowPlugin from "../main";
import { DEFAULT_NS } from "../core/namespace/namespace";
import type { CalendarField, ExternalCalendarSub } from "./Settings";
import {
	CALENDAR_FIELDS,
	commitSubName,
	formatDeferPresets,
	formatNamespaces,
	parseDeferPresets,
	parseIntInRange,
	parseNamespaces,
	reorderCalendarPlacement,
} from "./settingsFormat";

const CALENDAR_FIELD_LABEL: Record<CalendarField, string> = {
	due: "Срок (📅 due)",
	scheduled: "Запланировано (⏳ scheduled)",
	start: "Старт (🛫 start)",
};

/** Пн…Вс в порядке отображения; значение — как в модели (0=вс … 6=сб). */
const WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 1, label: "Понедельник" },
	{ value: 2, label: "Вторник" },
	{ value: 3, label: "Среда" },
	{ value: 4, label: "Четверг" },
	{ value: 5, label: "Пятница" },
	{ value: 6, label: "Суббота" },
	{ value: 0, label: "Воскресенье" },
];

export class GtdSettingsTab extends PluginSettingTab {
	private readonly plugin: GtdFlowPlugin;

	constructor(app: App, plugin: GtdFlowPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.sectionInbox(containerEl);
		this.sectionNamespaces(containerEl);
		this.sectionProjects(containerEl);
		this.sectionCalendar(containerEl);
		this.sectionExternal(containerEl);
		this.sectionDefer(containerEl);
		this.sectionRecurring(containerEl);
		this.sectionCards(containerEl);
		this.sectionBoards(containerEl);
		this.sectionMisc(containerEl);
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	// ── Входящие ────────────────────────────────────────────────────────────

	private sectionInbox(el: HTMLElement): void {
		new Setting(el).setName("Входящие").setHeading();

		new Setting(el)
			.setName("Входящие: включать задачи из обычных заметок")
			.setDesc(
				"По умолчанию выключено: во «Входящие» попадают только файлы GTD Flow — " +
					"захват (gtd-inbox) и готовые задачи проектов. Включите, если хотите видеть " +
					"во входящих активные неразобранные задачи из любых заметок хранилища. " +
					"На календарь, отложенные и доски не влияет.",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.inboxIncludePlain);
				toggle.onChange(async (value) => {
					this.plugin.settings.inboxIncludePlain = value;
					await this.save();
				});
			});
	}

	// ── Пространства ──────────────────────────────────────────────────────────

	private sectionNamespaces(el: HTMLElement): void {
		new Setting(el).setName("Пространства GTD").setHeading();

		new Setting(el)
			.setName("Корневая папка «Общего»")
			.setDesc(
				"Дом для файлов, СОЗДАВАЕМЫХ в пространстве «Общее» (быстрый ввод, доски, проекты и " +
					"пр. — по конвенции от этой папки, ровно как именованное пространство создаёт от " +
					"своего корня): например захват «Общего» уходит в «<папка>/Входящие.md». Это папка " +
					"ДЛЯ СОЗДАНИЯ, а не признак принадлежности — любой файл ВНЕ корней пространств " +
					"относится к «Общему» независимо от того, где лежит. По умолчанию «GTD».",
			)
			.addText((text) => {
				text.setPlaceholder("GTD");
				text.setValue(this.plugin.settings.commonRoot);
				text.onChange(async (value) => {
					this.plugin.settings.commonRoot = value.trim();
					await this.save();
				});
			});

		const setting = new Setting(el)
			.setName("Список пространств")
			.setDesc(
				"Несколько независимых GTD в одном хранилище: «Имя: корневая/папка», по одной " +
					"на строку. Пример: «Работа: Areas/Work». Файл принадлежит пространству с самым " +
					"длинным совпавшим корнем; всё вне корней — встроенное пространство «Общее». " +
					"Frontmatter «gtd-namespace: Имя» перебивает папку (для файла-исключения вне своей " +
					"папки). Пусто (по умолчанию) — пространств нет, поведение и интерфейс прежние. " +
					"Активное пространство переключается селектором в шапках видов или командой " +
					"«Переключить пространство GTD».",
			);
		// Живая валидация: нераспознанные строки не сохраняются и перечисляются тут.
		const errorEl = el.createDiv({ cls: "setting-item-description mod-warning" });
		setting.addTextArea((text) => {
			text.inputEl.rows = 4;
			text.setPlaceholder("Работа: Areas/Work\nЛичное: Areas/Personal");
			text.setValue(formatNamespaces(this.plugin.settings.namespaces));
			text.onChange(async (raw) => {
				const { namespaces, invalid } = parseNamespaces(raw);
				errorEl.setText(
					invalid.length > 0
						? `Не распознано (формат «Имя: Папка», имя уникально): ${invalid.join("; ")}`
						: "",
				);
				// мутация НА МЕСТЕ (splice), не подмена ссылки: смонтированные виды
				// держат ссылку на этот массив в props — подмена оставила бы им
				// застывший снапшот списка (ревью)
				this.plugin.settings.namespaces.splice(
					0,
					this.plugin.settings.namespaces.length,
					...namespaces,
				);
				// активное пространство могло указывать на удалённое/переименованное — нормализуем
				// через setActiveNamespace: откатит к «Общему» и пере-рендерит виды своим store
				// (смена настроек эпоху индекса не бампает). Он же персистит настройки.
				this.plugin.setActiveNamespace(this.plugin.settings.activeNamespace);
				// имя могло не смениться (setActiveNamespace тогда молчит) — форс-толчок,
				// чтобы открытые виды перечитали обновлённый список пространств
				this.plugin.pokeNamespaceViews();
				await this.save();
			});
		});
	}

	// ── Проекты ─────────────────────────────────────────────────────────────

	private sectionProjects(el: HTMLElement): void {
		new Setting(el).setName("Проекты").setHeading();

		new Setting(el)
			.setName("Признак принадлежности проекту")
			.setDesc("Как задача вне файлов gtd-project считается принадлежащей проекту.")
			.addDropdown((dd) => {
				dd.addOption("tag", "По тегу");
				dd.addOption("folder", "По папке");
				dd.setValue(this.plugin.settings.projectStrategy);
				dd.onChange(async (value) => {
					this.plugin.settings.projectStrategy = value === "folder" ? "folder" : "tag";
					await this.save();
				});
			});

		new Setting(el)
			.setName("Префикс тега проекта")
			.setDesc("Используется при стратегии «по тегу».")
			.addText((text) => {
				text.setPlaceholder("#project/");
				text.setValue(this.plugin.settings.projectTagPrefix);
				text.onChange(async (value) => {
					this.plugin.settings.projectTagPrefix = value;
					await this.save();
				});
			});
	}

	// ── Календарь ───────────────────────────────────────────────────────────

	private sectionCalendar(el: HTMLElement): void {
		new Setting(el).setName("Календарь").setHeading();

		const order = this.plugin.settings.calendarPlacement;
		const primary: CalendarField = order[0] ?? "due";
		new Setting(el)
			.setName("Основное поле даты")
			.setDesc(
				"По какому полю задача попадает в день календаря; если оно пусто, берётся следующее. " +
					`Текущий порядок: ${order.map((f) => CALENDAR_FIELD_LABEL[f]).join(" → ")}.`,
			)
			.addDropdown((dd) => {
				for (const f of CALENDAR_FIELDS) dd.addOption(f, CALENDAR_FIELD_LABEL[f]);
				dd.setValue(primary);
				dd.onChange(async (value) => {
					const field = CALENDAR_FIELDS.find((f) => f === value) ?? "due";
					this.plugin.settings.calendarPlacement = reorderCalendarPlacement(
						this.plugin.settings.calendarPlacement,
						field,
					);
					await this.save();
					this.display(); // обновить «Текущий порядок» в описании
				});
			});

		new Setting(el)
			.setName("Первый день недели")
			.addDropdown((dd) => {
				for (const d of WEEKDAYS) dd.addOption(String(d.value), d.label);
				dd.setValue(String(this.plugin.settings.firstDayOfWeek));
				dd.onChange(async (value) => {
					const n = parseIntInRange(value, 0, 6);
					if (n === null) return;
					this.plugin.settings.firstDayOfWeek = n;
					await this.save();
				});
			});

		new Setting(el)
			.setName("Файл повторяющихся событий")
			.setDesc("Куда сохраняются серии календаря (frontmatter gtd-events: true). Создаётся при первом сохранении серии.")
			.addText((text) => {
				text.setPlaceholder("GTD/Events.md");
				text.setValue(this.plugin.settings.eventsFile);
				text.onChange(async (value) => {
					this.plugin.settings.eventsFile = value.trim();
					await this.save();
				});
			});

		new Setting(el)
			.setName("Файл статусов дней")
			.setDesc(
				"Файл для покраски дней календаря (frontmatter gtd-day-status: true). Создаётся при " +
					"первой покраске. Статусы дней ОБЩИЕ для всех пространств. Если оставить путь " +
					"по умолчанию, файл создаётся в «Корневой папке Общего» и следует за её сменой; " +
					"свой путь задаётся осознанно и за папкой не следует.",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/DayStatus.md");
				text.setValue(this.plugin.settings.dayStatusFile);
				text.onChange(async (value) => {
					this.plugin.settings.dayStatusFile = value.trim();
					await this.save();
				});
			});
	}

	// ── Внешние календари (ICS) ───────────────────────────────────────────────

	private sectionExternal(el: HTMLElement): void {
		new Setting(el).setName("Внешние календари").setHeading();

		new Setting(el).setName("Подписки на iCal-ленты (ICS)").setDesc(
			"Секретный адрес Google Calendar, published-ссылка Outlook или любой .ics-URL " +
				"материализуются в файлы-зеркала «<корень пространства>/External/<имя>.md» и " +
				"появляются в календаре/агенде/виджетах как обычные события. Зеркала — только для " +
				"чтения (перезаписываются синхронизацией); окно развёртки: 14 дней назад и 92 вперёд.",
		);

		this.intSetting(
			new Setting(el)
				.setName("Интервал синхронизации, мин")
				.setDesc("Как часто опрашивать ленты (минимум 1). Изменение применяется сразу."),
			{
				min: 1,
				max: 1440,
				get: () => this.plugin.settings.externalSyncIntervalMin,
				set: (v) => {
					this.plugin.settings.externalSyncIntervalMin = v;
					this.plugin.sync.restart();
				},
			},
		);

		const subs = this.plugin.settings.externalCalendars;
		if (subs.length === 0) {
			el.createDiv({ cls: "setting-item-description", text: "Подписок пока нет." });
		}
		for (const sub of subs) this.renderExternalSub(el, sub);

		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText("Синхронизировать сейчас")
					.setDisabled(subs.length === 0)
					.onClick(async () => {
						await this.plugin.sync.syncAll();
						this.display();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Добавить подписку")
					.setCta()
					.onClick(async () => {
						subs.push({
							id: genSubId(),
							name: "Новый календарь",
							url: "",
							namespace: DEFAULT_NS,
							lastSyncAt: null,
							lastError: null,
						});
						await this.save();
						this.display();
					}),
			);
	}

	/** Одна подписка: имя + пространство + статус + кнопки (строка 1), адрес ленты
	 *  с предупреждением о секретности (строка 2). */
	private renderExternalSub(el: HTMLElement, sub: ExternalCalendarSub): void {
		const row = new Setting(el)
			.setName(sub.name.trim() === "" ? "(без имени)" : sub.name)
			.setDesc(formatSyncStatus(sub));

		row.addText((t) => {
			t.setPlaceholder("Имя");
			t.setValue(sub.name);
			// Коммит по blur/Enter, НЕ на каждую букву. Раньше onChange на КАЖДЫЙ символ
			// звал deleteMirror(старое имя) → app.vault.trash зеркала; эта мутация
			// хранилища на первом же символе провоцировала пересоздание инпута и потерю
			// фокуса («Луна» → «Л»). Теперь во время набора не происходит НИЧЕГО; на
			// blur/Enter, если имя реально изменилось — удалить старое зеркало (ровно раз),
			// сохранить и перерисовать строку (заголовок «(без имени)»/имя и статус).
			commitOnBlur(t.inputEl, async () => {
				const renamed = await commitSubName(sub, t.getValue(), {
					// commitSubName читает старое имя из sub.name ДО мутации — зеркало
					// удаляется по старому пути (id+старое имя), детерминированно и один раз.
					deleteMirror: (oldName) => this.plugin.sync.deleteMirror({ ...sub, name: oldName }),
					save: () => this.save(),
				});
				if (renamed) this.display();
				else t.setValue(sub.name); // нормализовать отображение (trim), фокус свободен
			});
		});

		row.addDropdown((dd) => {
			dd.addOption(DEFAULT_NS, "Общее");
			for (const ns of this.plugin.settings.namespaces) dd.addOption(ns.name, ns.name);
			// персистнутое пространство могло исчезнуть из списка — откат к «Общему»
			const known =
				sub.namespace === DEFAULT_NS ||
				this.plugin.settings.namespaces.some((n) => n.name === sub.namespace);
			dd.setValue(known ? sub.namespace : DEFAULT_NS);
			dd.onChange(async (v) => {
				sub.namespace = v;
				await this.save();
			});
		});

		row.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Синхронизировать сейчас")
				.onClick(async () => {
					await this.plugin.sync.syncById(sub.id);
					this.display();
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("Удалить подписку")
				.onClick(async () => {
					// сперва убрать файл-зеркало (в корзину), пока подписка ещё в списке —
					// путь считается от её id+имени; иначе зеркало осиротело бы в хранилище
					await this.plugin.sync.deleteMirror(sub);
					const subs = this.plugin.settings.externalCalendars;
					const i = subs.indexOf(sub);
					if (i >= 0) subs.splice(i, 1);
					await this.save();
					this.display();
				}),
		);

		const urlSetting = new Setting(el).setName("Адрес ленты (.ics)").setDesc(
			"Поддерживаются http(s):// и webcal:// (кнопки «Подписаться» Apple/Google — " +
				"webcal автоматически заменяется на https). Внимание: секретный ICS-адрес — это " +
				"доступ к вашему календарю на ЧТЕНИЕ. Храните его как пароль; он лежит локально в data.json.",
		);
		urlSetting.addText((t) => {
			t.setPlaceholder("https://…/basic.ics");
			t.setValue(sub.url);
			t.inputEl.style.width = "100%";
			// Коммит по blur/Enter (как имя): во время набора не пишем в data.json.
			// Без this.display() — чтобы поле не мигало; статус обновит следующий синк.
			commitOnBlur(t.inputEl, async () => {
				const next = t.getValue().trim();
				t.setValue(next); // показать нормализованное значение (blur — фокус свободен)
				if (next === sub.url) return; // без изменений — не будим saveData впустую
				sub.url = next;
				await this.save();
			});
		});
		urlSetting.settingEl.style.paddingTop = "0";
	}

	// ── Отложенные ──────────────────────────────────────────────────────────

	private sectionDefer(el: HTMLElement): void {
		new Setting(el).setName("Отложенные").setHeading();

		const setting = new Setting(el)
			.setName("Пресеты откладывания")
			.setDesc(
				"Пункты меню «Отложить до…», по одному на строку в формате «Метка|дни», " +
					"где дни — целое смещение от сегодня. Например: Завтра|1",
			);
		// Живая валидация: нераспознанные строки не сохраняются и перечисляются тут.
		const errorEl = el.createDiv({ cls: "setting-item-description mod-warning" });
		setting.addTextArea((text) => {
			text.inputEl.rows = 4;
			text.setPlaceholder("Завтра|1\n+3 дня|3\nЧерез неделю|7");
			text.setValue(formatDeferPresets(this.plugin.settings.deferPresets));
			text.onChange(async (raw) => {
				const { presets, invalid } = parseDeferPresets(raw);
				errorEl.setText(invalid.length > 0 ? `Не распознано (формат «Метка|дни»): ${invalid.join("; ")}` : "");
				this.plugin.settings.deferPresets = presets;
				await this.save();
			});
		});
	}

	// ── Регулярные ──────────────────────────────────────────────────────────

	private sectionRecurring(el: HTMLElement): void {
		new Setting(el).setName("Регулярные").setHeading();

		new Setting(el)
			.setName("Файл для новых копий")
			.setDesc(
				"Куда добавляются вхождения регулярных задач при наступлении срока — это цель для " +
					"«Общего»; шаблон именованного пространства спавнит в его «<корень>/Входящие.md». " +
					"За «Корневой папкой Общего» этот путь НЕ следует — при её смене поправьте здесь вручную.",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/Inbox.md");
				text.setValue(this.plugin.settings.recurring.spawnTarget);
				text.onChange(async (value) => {
					this.plugin.settings.recurring.spawnTarget = value.trim();
					await this.save();
				});
			});

		new Setting(el)
			.setName("Догон пропущенных")
			.setDesc(
				"Что делать с вхождениями, срок которых прошёл, пока Obsidian был закрыт. " +
					"«Только последнее» — одна свежайшая копия на шаблон: после трёх месяцев отпуска " +
					"одно «ревью приоритетов» — сигнал, три — шум. «Все пропущенные» — каждая, " +
					"но не больше лимита ниже. «Не догонять» — пропущенные не создаются вовсе.",
			)
			.addDropdown((dd) => {
				dd.addOption("latest", "Только последнее");
				dd.addOption("all", "Все пропущенные");
				dd.addOption("none", "Не догонять");
				dd.setValue(this.plugin.settings.recurring.catchUp);
				dd.onChange(async (value) => {
					this.plugin.settings.recurring.catchUp = value === "all" || value === "none" ? value : "latest";
					await this.save();
				});
			});

		this.intSetting(
			new Setting(el)
				.setName("Лимит догона")
				.setDesc("Максимум копий одного шаблона за проход в режиме «все пропущенные»."),
			{
				min: 1,
				max: 1000,
				get: () => this.plugin.settings.recurring.catchUpCap,
				set: (v) => (this.plugin.settings.recurring.catchUpCap = v),
			},
		);
	}

	// ── Карточки ────────────────────────────────────────────────────────────

	private sectionCards(el: HTMLElement): void {
		new Setting(el).setName("Карточки").setHeading();

		new Setting(el)
			.setName("Папка карточек")
			.setDesc("Куда создаются заметки-карточки задач.")
			.addText((text) => {
				text.setPlaceholder("GTD/Cards");
				text.setValue(this.plugin.settings.cardsFolder);
				text.onChange(async (value) => {
					this.plugin.settings.cardsFolder = value.trim();
					await this.save();
				});
			});

		new Setting(el)
			.setName("Ссылка на карточку в строке задачи")
			.setDesc("При создании карточки добавлять в строку задачи ссылку на неё.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.cardLinkInLine);
				toggle.onChange(async (value) => {
					this.plugin.settings.cardLinkInLine = value;
					await this.save();
				});
			});
	}

	// ── Доски ───────────────────────────────────────────────────────────────

	private sectionBoards(el: HTMLElement): void {
		new Setting(el).setName("Доски").setHeading();

		new Setting(el)
			.setName("Доска по умолчанию")
			.setDesc("Путь к файлу доски для вида Kanban. Пусто — первая найденная в хранилище.")
			.addText((text) => {
				text.setPlaceholder("GTD/Board.md");
				text.setValue(this.plugin.settings.defaultBoardPath);
				text.onChange(async (value) => {
					this.plugin.settings.defaultBoardPath = value.trim();
					await this.save();
				});
			});

		new Setting(el)
			.setName("Файл архива")
			.setDesc("Куда переносятся выполненные/отменённые карточки при «Архивировать» (frontmatter gtd-archive: true).")
			.addText((text) => {
				text.setPlaceholder("GTD/Archive.md");
				text.setValue(this.plugin.settings.archiveFile);
				text.onChange(async (value) => {
					this.plugin.settings.archiveFile = value.trim();
					await this.save();
				});
			});
	}

	// ── Прочее ──────────────────────────────────────────────────────────────

	private sectionMisc(el: HTMLElement): void {
		new Setting(el).setName("Прочее").setHeading();

		new Setting(el)
			.setName("Автовставка идентификатора")
			.setDesc(
				"Присваивать задаче 🆔 при первой записи из видов плагина. " +
					"Изменение вступает в силу после перезапуска плагина.",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoInjectId);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoInjectId = value;
					await this.save();
				});
			});

		this.intSetting(
			new Setting(el)
				.setName("Порог виртуализации")
				.setDesc("Списки длиннее порога рендерятся виртуально (быстрее на больших хранилищах)."),
			{
				min: 0,
				max: 100000,
				get: () => this.plugin.settings.virtualizeThreshold,
				set: (v) => (this.plugin.settings.virtualizeThreshold = v),
			},
		);

		new Setting(el)
			.setName("Возврат отложенной задачи")
			.setDesc(
				"Куда «всплывает» задача, когда наступает её дата старта. " +
					"«В исходное место» — остаётся в своём файле и снова проходит запрос входящих. " +
					"«Во входящие» (по умолчанию) — снимается 🛫, снимаются теги доски, а строка " +
					"переносится в файл входящих своего пространства, чтобы задача точно попала во «Входящие».",
			)
			.addDropdown((dd) => {
				dd.addOption("origin", "В исходное место");
				dd.addOption("inbox", "Во входящие");
				dd.setValue(this.plugin.settings.promoteTo);
				dd.onChange(async (value) => {
					this.plugin.settings.promoteTo = value === "inbox" ? "inbox" : "origin";
					await this.save();
				});
			});

		this.intSetting(
			new Setting(el)
				.setName("Задержка переиндексации файла, мс")
				.setDesc("Для продвинутых. Дебаунс реакции на правки файлов. Вступает в силу после перезапуска плагина."),
			{
				min: 0,
				max: 10000,
				get: () => this.plugin.settings.debounceMs.fileReindex,
				set: (v) => (this.plugin.settings.debounceMs.fileReindex = v),
			},
		);

		this.intSetting(
			new Setting(el)
				.setName("Задержка пересчёта запросов, мс")
				.setDesc("Для продвинутых. Дебаунс пересчёта видов после изменения индекса."),
			{
				min: 0,
				max: 10000,
				get: () => this.plugin.settings.debounceMs.queryRecompute,
				set: (v) => (this.plugin.settings.debounceMs.queryRecompute = v),
			},
		);
	}

	// ── Хелперы ─────────────────────────────────────────────────────────────

	/**
	 * Целочисленное поле: валидное значение сохраняется сразу; мусор (NaN,
	 * дробь, вне диапазона) не пишется и на blur откатывается к последнему
	 * сохранённому значению.
	 */
	private intSetting(
		setting: Setting,
		opts: { min: number; max: number; get: () => number; set: (v: number) => void },
	): void {
		setting.addText((text) => {
			text.inputEl.type = "number";
			text.setValue(String(opts.get()));
			text.onChange(async (raw) => {
				const v = parseIntInRange(raw, opts.min, opts.max);
				if (v === null) return;
				opts.set(v);
				await this.save();
			});
			text.inputEl.addEventListener("blur", () => {
				text.setValue(String(opts.get()));
			});
		});
	}
}

/** Короткий стабильный id новой подписки (время + случайный хвост). */
function genSubId(): string {
	return `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Навесить коммит-по-потере-фокуса (+Enter) на текстовый инпут: во время набора
 * НИЧЕГО не сохраняется, изменения фиксируются на blur или по Enter (Enter лишь
 * снимает фокус — единый путь коммита через blur). Так поля «имя» и «адрес ленты»
 * подписок не пересоздаются на каждый символ и не теряют фокус (ср. числовые поля,
 * которые пишут валидное значение сразу, но откатывают мусор на blur — intSetting).
 */
function commitOnBlur(inputEl: HTMLInputElement, commit: () => void | Promise<void>): void {
	inputEl.addEventListener("blur", () => void commit());
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			inputEl.blur();
		}
	});
}

/** Человекочитаемый статус подписки для описания строки. */
function formatSyncStatus(sub: ExternalCalendarSub): string {
	if (sub.lastError !== null) return `⚠ ошибка: ${sub.lastError}`;
	if (sub.lastSyncAt === null) return "ещё не синхронизировалось";
	const d = new Date(sub.lastSyncAt);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `обновлено ${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}.${p(d.getMonth() + 1)}`;
}
