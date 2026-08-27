/**
 * Вкладка настроек (ТЗ §9). Каждое изменение — мутация plugin.settings +
 * saveSettings. Числовые поля: валидное значение пишется сразу, мусор
 * не пишется вовсе и откатывается к последнему сохранённому на blur.
 */
import { Modal, Notice, PluginSettingTab, SecretComponent, Setting, type App } from "obsidian";
import type GtdFlowPlugin from "../main";
import {
	AI_FEEDBACK_INSPECTION_LIMIT,
	type AiFeedbackInspection,
	type AiFeedbackInspectionEvent,
} from "../services/MetadataServices";
import type {
	ActiveCalendarSub,
	CalDavAccount,
	CalDavCalendarSub,
	CalendarField,
	IcsCalendarSub,
	InvalidCalendarSub,
} from "./Settings";
import {
	CALENDAR_FIELDS,
	commitInboxFile,
	commitPrivacyMode,
	commitSubName,
	describeSyncErrorCode,
	formatDeferPresets,
	formatSyncStatus,
	isValidCaldavOrigin,
	parseDeferPresets,
	parseIntInRange,
	removeCaldavAccount,
	reorderCalendarPlacement,
} from "./settingsFormat";
import { ExternalSyncError, NEVER_ATTEMPTED_STATUS } from "../sync/externalSyncStatus";
import { reportAsync } from "../views/common/runAction";
import { confirm } from "../views/common/ConfirmModal";
import { recreateScopeCatalogWithConfirm } from "../views/common/scopeRecovery";
import { SCOPE_CATALOG_PATH } from "../services/ScopeCatalogService";
import type { SecretStorageCredentials } from "../adapters/SecretStorageCredentials";
import type { DiscoveredCalendar } from "../sync/caldav/protocol";

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
	private readonly desktopFeatures: boolean;
	// Гейт секции внешних календарей: отдельный от desktopFeatures, чтобы
	// календарная синхронизация не зависела от политики AI/desktop-видов.
	private readonly calendarSync: boolean;
	/** Обнаруженные CalDAV-коллекции ЭТОГО процесса (per-tab UI state, НЕ
	 *  персистится): accountId → результат последнего успешного «Обнаружить
	 *  календари». Кэш href живёт отдельно в SecretStorage (§5.1). */
	private readonly discovered = new Map<string, readonly DiscoveredCalendar[]>();
	/** Открыта ли инлайн-форма «Добавить CalDAV-аккаунт». */
	private addingCaldavAccount = false;
	/** id аккаунта, для которого сейчас открыта форма «Обновить учётные данные»
	 *  (та же форма, что и добавление, только предцелена на существующий аккаунт). */
	private editingCaldavCredentialsFor: string | null = null;

	constructor(
		app: App,
		plugin: GtdFlowPlugin,
		options: { desktopFeatures?: boolean; calendarSync?: boolean } = {},
	) {
		super(app, plugin);
		this.plugin = plugin;
		this.desktopFeatures = options.desktopFeatures ?? true;
		this.calendarSync = options.calendarSync ?? this.desktopFeatures;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.sectionInbox(containerEl);
		this.sectionScopes(containerEl);
		if (this.desktopFeatures) this.sectionAi(containerEl);
		if (this.desktopFeatures) this.sectionProjects(containerEl);
		this.sectionCalendar(containerEl);
		if (this.calendarSync) this.sectionExternal(containerEl);
		if (this.desktopFeatures) this.sectionDefer(containerEl);
		this.sectionRecurring(containerEl);
		if (this.desktopFeatures) this.sectionCards(containerEl);
		if (this.desktopFeatures) this.sectionBoards(containerEl);
		this.sectionMisc(containerEl);
	}

	// ── Scopes ──────────────────────────────────────────────────────────────

	private sectionScopes(el: HTMLElement): void {
		new Setting(el).setName("Scope").setHeading();
		const scopes = [...this.plugin.scopes.current().scopes].sort(
			(left, right) => left.order - right.order || left.name.localeCompare(right.name),
		);
		if (!this.plugin.scopes.isMutationSafe()) {
			el.createDiv({
				cls: "setting-item-description",
				text: `Каталог scope (${SCOPE_CATALOG_PATH}) повреждён — создание и правка scope заблокированы. Нажмите «Пересоздать каталог scope…»: старый файл сохранится рядом как .bak-…`,
			});
		}
		if (scopes.length === 0) {
			el.createDiv({
				cls: "setting-item-description",
				text: "Создайте хотя бы один scope: AI обязан выбрать ровно один активный scope для обработанной задачи.",
			});
		}
		for (const [index, scope] of scopes.entries()) {
			const row = new Setting(el)
				.setName(scope.name)
				.setDesc(
					scope.archived ? `ID: ${scope.id} · архивирован` : `ID: ${scope.id} · активен`,
				);
			row.addText((text) => {
				text.setValue(scope.name);
				commitOnBlur(text.inputEl, async () => {
					const name = text.getValue().trim();
					if (name === "" || name === scope.name) {
						text.setValue(scope.name);
						return;
					}
					await this.plugin.scopes.rename(scope.id, name);
					this.display();
				});
			});
			row.addButton((button) =>
				button
					.setButtonText("↑")
					.setTooltip("Выше")
					.setDisabled(index === 0)
					.onClick(() =>
						this.reportAction("scope не перемещён", async () => {
							const ids = scopes.map((item) => item.id);
							[ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
							await this.plugin.scopes.reorder(ids);
							this.display();
						}),
					),
			);
			row.addButton((button) =>
				button
					.setButtonText("↓")
					.setTooltip("Ниже")
					.setDisabled(index === scopes.length - 1)
					.onClick(() =>
						this.reportAction("scope не перемещён", async () => {
							const ids = scopes.map((item) => item.id);
							[ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
							await this.plugin.scopes.reorder(ids);
							this.display();
						}),
					),
			);
			row.addButton((button) =>
				button.setButtonText(scope.archived ? "Вернуть" : "Архивировать").onClick(() =>
					this.reportAction("статус scope не изменён", async () => {
						await this.plugin.scopes.setArchived(scope.id, !scope.archived);
						this.display();
					}),
				),
			);
			row.addButton((button) =>
				button
					.setButtonText("Удалить")
					.setWarning()
					.onClick(() =>
						this.reportAction("scope не удалён", async () => {
							if (
								!(await confirm(
									this.app,
									"Удалить scope?",
									`Scope «${scope.name}» можно удалить только если ни одна задача на него не ссылается.`,
									"Удалить",
								))
							)
								return;
							await this.plugin.scopes.delete(scope.id);
							this.display();
						}),
					),
			);
		}

		let newScopeName = "";
		new Setting(el)
			.setName("Новый scope")
			.setDesc("Имя можно менять позже; стабильный ID задачи при этом не переписывается.")
			.addText((text) => {
				text.setPlaceholder("Например, Work");
				text.onChange((value) => {
					newScopeName = value;
				});
			})
			.addButton((button) =>
				button
					.setButtonText("Создать")
					.setCta()
					.onClick(() =>
						this.reportAction("scope не создан", async () => {
							await this.plugin.scopes.create(newScopeName);
							this.display();
						}),
					),
			);

		new Setting(el)
			.setName("Пересоздать каталог scope…")
			.setDesc(
				`Аварийный выход, если ${SCOPE_CATALOG_PATH} испорчен и изменения заблокированы: старый файл сохраняется рядом как .bak-<дата>, на его место пишется пустой каталог. Та же команда есть в палитре.`,
			)
			.addButton((button) =>
				button
					.setButtonText("Пересоздать")
					.setWarning()
					.onClick(() =>
						this.reportAction("каталог scope не пересоздан", async () => {
							if (await recreateScopeCatalogWithConfirm(this.app, this.plugin.scopes))
								this.display();
						}),
					),
			);
	}

	// ── AI and estimates ────────────────────────────────────────────────────

	private sectionAi(el: HTMLElement): void {
		new Setting(el).setName("AI и оценки").setHeading();
		const ai = this.plugin.ai;
		if (ai === null) {
			new Setting(el)
				.setName("AI недоступен")
				.setDesc("Desktop AI runtime не был инициализирован в этой сессии.");
			return;
		}

		new Setting(el)
			.setName("Включить AI")
			.setDesc(
				"Сетевые запросы выполняются только по явной команде или сообщению в GTD AI. Автоматической обработки изменений нет.",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.ai.enabled);
				toggle.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.ai.enabled = value;
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Политика приватности OpenRouter")
			.setDesc(
				"По умолчанию маршрутизация следует политике вашего аккаунта OpenRouter. Необязательный строгий ZDR работает fail-closed и может оставить бесплатный маршрут без совместимой модели.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("account-policy", "Политика аккаунта OpenRouter");
				dropdown.addOption("require-zdr", "Требовать Zero Data Retention");
				dropdown.setValue(this.plugin.settings.ai.privacyPolicy);
				dropdown.onChange((value) =>
					this.reportChange(async () => {
						if (value !== "account-policy" && value !== "require-zdr") return;
						this.plugin.settings.ai.privacyPolicy = value;
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Хранение OAuth-ключа")
			.setDesc(
				"В MVP доступен только безопасный memory-only режим: ключ не попадает в vault/data.json, но после перезапуска нужно подключиться снова.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("memory-only", "Только в памяти процесса");
				dropdown.setValue(this.plugin.settings.ai.credentialStorage);
				dropdown.onChange((value) =>
					this.reportChange(async () => {
						if (value !== "memory-only") return;
						this.plugin.settings.ai.credentialStorage = value;
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Формат длительности")
			.setDesc(
				"Минимум — 5 минут. До 24 часов используются шаги по 5 минут; 24 часа и больше принимаются только целыми днями и показываются как 1d, 2d и т. д.",
			);

		new Setting(el)
			.setName("OpenRouter")
			.setDesc("OAuth использует PKCE/S256 и временный callback на 127.0.0.1.")
			.addButton((button) =>
				button
					.setButtonText("Открыть GTD AI")
					.setCta()
					.onClick(() =>
						this.reportAction("вид GTD AI не открыт", async () => {
							await this.plugin.activateView("ai");
						}),
					),
			)
			.addButton((button) =>
				button.setButtonText("Подключить").onClick(() =>
					this.reportAction("OpenRouter не подключён", async () => {
						const port = this.plugin.aiViewPort;
						if (port === null) throw new Error("desktop-ai-view-unavailable");
						await port.connect();
						this.display();
					}),
				),
			)
			.addButton((button) =>
				button.setButtonText("Отключить").onClick(() =>
					this.reportAction("OpenRouter не отключён", async () => {
						const port = this.plugin.aiViewPort;
						if (port === null) throw new Error("desktop-ai-view-unavailable");
						await port.disconnect();
						this.display();
					}),
				),
			);

		const history = new Setting(el).setName("История обучения").setDesc("Загрузка…");
		void ai.feedbackSummary().then(
			(summary) => {
				history.setDesc(
					`Синхронизированных событий: ${summary.events}; повреждённых событий: ${summary.invalidRecords}. Outbox: ожидают обработки — ${summary.pendingOutbox}, конфликтов — ${summary.conflictedOutbox}, повреждённых — ${summary.invalidOutboxRecords}. Экспорт содержит записи outbox для ручной диагностики.`,
				);
			},
			() => {
				history.setDesc("Историю сейчас прочитать не удалось.");
			},
		);
		history
			.addButton((button) =>
				button.setButtonText("Просмотреть").onClick(() =>
					this.reportAction("история не открыта", async () => {
						const inspection = await ai.feedbackInspection();
						new AiLearningHistoryModal(this.app, inspection).open();
					}),
				),
			)
			.addButton((button) =>
				button.setButtonText("Экспорт").onClick(() =>
					this.reportAction("история не экспортирована", async () => {
						const path = await this.plugin.exportAiLearningHistory();
						new Notice(`GTD Flow: история экспортирована в ${path}`);
					}),
				),
			)
			.addButton((button) =>
				button
					.setButtonText("Очистить")
					.setWarning()
					.onClick(() =>
						this.reportAction("история не очищена", async () => {
							if (
								!(await confirm(
									this.app,
									"Очистить историю обучения?",
									"Будут удалены feedback-файлы и незавершённые записи outbox. Текущие значения в Markdown и разговоры останутся; поля с конфликтами сохранят безопасную user-lock отметку.",
									"Очистить",
								))
							)
								return;
							const count = await ai.clearFeedbackConfirmed();
							new Notice(`GTD Flow: удалено событий обучения: ${count}`);
							this.display();
						}),
					),
			);
	}

	private save(): Promise<void> {
		// Callers all go through reportChange/reportAction/commitOnBlur, which own
		// the UI boundary and must observe persistence failures to stop follow-ups.
		return this.plugin.saveSettings();
	}

	// ── Входящие ────────────────────────────────────────────────────────────

	private sectionInbox(el: HTMLElement): void {
		new Setting(el).setName("Входящие").setHeading();

		new Setting(el)
			.setName("Файл входящих")
			.setDesc(
				"Единственный Markdown-файл для быстрого ввода, регулярных задач и возврата отложенных.",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/Inbox.md");
				text.setValue(this.plugin.settings.inboxFile);
				// Коммит по blur/Enter, НЕ на каждую букву (как имя и адрес подписки).
				// От папки этого файла считается путь зеркал ICS, поэтому запись на
				// каждый символ таскала зеркала по промежуточным путям (набор
				// «GTD/Inbox.md» успевал создать зеркало в корне, отправить его в
				// корзину и пересоздать) и на каждое поколение конфигурации
				// перезапускала полный сетевой проход по всем лентам.
				commitOnBlur(text.inputEl, async () => {
					const changed = await commitInboxFile(this.plugin.settings, text.getValue(), {
						reconcile: () => {
							if (this.calendarSync) {
								this.plugin.desktopCalendarSync().configurationChanged();
							}
						},
						save: () => this.save(),
					});
					// нормализовать отображение (trim / откат пустого ввода) — фокус свободен
					if (!changed) text.setValue(this.plugin.settings.inboxFile);
				});
			});

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
				toggle.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.inboxIncludePlain = value;
						await this.save();
					}),
				);
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
				dd.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.projectStrategy =
							value === "folder" ? "folder" : "tag";
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Префикс тега проекта")
			.setDesc("Используется при стратегии «по тегу».")
			.addText((text) => {
				text.setPlaceholder("#project/");
				text.setValue(this.plugin.settings.projectTagPrefix);
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.projectTagPrefix = value;
						await this.save();
					}),
				);
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
				dd.onChange((value) =>
					this.reportChange(async () => {
						const field = CALENDAR_FIELDS.find((f) => f === value) ?? "due";
						this.plugin.settings.calendarPlacement = reorderCalendarPlacement(
							this.plugin.settings.calendarPlacement,
							field,
						);
						await this.save();
						this.display(); // обновить «Текущий порядок» в описании
					}),
				);
			});

		new Setting(el).setName("Первый день недели").addDropdown((dd) => {
			for (const d of WEEKDAYS) dd.addOption(String(d.value), d.label);
			dd.setValue(String(this.plugin.settings.firstDayOfWeek));
			dd.onChange((value) =>
				this.reportChange(async () => {
					const n = parseIntInRange(value, 0, 6);
					if (n === null) return;
					this.plugin.settings.firstDayOfWeek = n;
					await this.save();
				}),
			);
		});

		new Setting(el)
			.setName("Файл повторяющихся событий")
			.setDesc(
				"Куда сохраняются серии календаря (frontmatter gtd-events: true). Создаётся при первом сохранении серии.",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/Events.md");
				text.setValue(this.plugin.settings.eventsFile);
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.eventsFile = value.trim();
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Файл статусов дней")
			.setDesc(
				"Файл для покраски дней календаря (frontmatter gtd-day-status: true). Создаётся при " +
					"первой покраске. Статусы дней общие для всего хранилища; файл всегда остаётся " +
					"по указанному здесь пути.",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/DayStatus.md");
				text.setValue(this.plugin.settings.dayStatusFile);
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.dayStatusFile = value.trim();
						await this.save();
					}),
				);
			});
	}

	// ── Внешние календари (ICS) ───────────────────────────────────────────────

	private sectionExternal(el: HTMLElement): void {
		new Setting(el).setName("Внешние календари").setHeading();

		new Setting(el)
			.setName("Подписки на iCal-ленты (ICS)")
			.setDesc(
				"Секретный адрес Google Calendar, published-ссылка Outlook или любой .ics-URL " +
					"материализуются рядом с единым inbox в «External/<имя>-<id>.md» и " +
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
					this.plugin.desktopCalendarSync().restart();
				},
			},
		);

		const subs = this.plugin.settings.externalCalendars;
		if (subs.length === 0) {
			el.createDiv({ cls: "setting-item-description", text: "Подписок пока нет." });
		}
		for (const sub of subs) {
			if (sub.kind === "invalid") this.renderInvalidSub(el, sub);
			else if (sub.kind === "caldav") this.renderCaldavSub(el, sub);
			else this.renderExternalSub(el, sub);
		}

		this.renderCaldavAccountsSection(el);

		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText("Синхронизировать сейчас")
					.setDisabled(subs.length === 0)
					.onClick(() =>
						this.reportAction("не удалось синхронизировать календари", async () => {
							await this.plugin.desktopCalendarSync().syncAll();
							this.display();
						}),
					),
			)
			.addButton((b) =>
				b
					.setButtonText("Добавить подписку")
					.setCta()
					.onClick(() =>
						this.reportChange(async () => {
							subs.push({
								id: genSubId(),
								name: "Новый календарь",
								url: "",
								lastSyncAt: null,
								lastError: null,
								errorCode: null,
							});
							await this.save();
							this.display();
						}),
					),
			);
	}

	/** Runtime-статус подписки текущего процесса (или «не было попыток», когда
	 *  сервис синхронизации не составлен — секция тогда и не рендерится). */
	private syncRuntime(sub: ActiveCalendarSub) {
		return this.calendarSync
			? this.plugin.desktopCalendarSync().runtimeStatus(sub.id)
			: NEVER_ATTEMPTED_STATUS;
	}

	/**
	 * Повреждённая запись подписки (не прошла схему при загрузке): не синкается
	 * и не активируется; пользователь может только удалить её. Зеркало записи
	 * (если было) защищено от orphan-очистки, пока запись существует; после
	 * удаления записи reconcile отправит зеркало в корзину (восстановимо).
	 */
	private renderInvalidSub(el: HTMLElement, sub: InvalidCalendarSub): void {
		new Setting(el)
			.setName("Повреждённая запись подписки")
			.setDesc(`Запись «${sub.id}» не прошла проверку формата и отключена (fail-closed).`)
			.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Удалить запись")
					.onClick(() =>
						this.reportChange(async () => {
							const subs = this.plugin.settings.externalCalendars;
							const i = subs.indexOf(sub);
							if (i >= 0) subs.splice(i, 1);
							if (this.calendarSync)
								this.plugin.desktopCalendarSync().configurationChanged();
							await this.save();
							this.display();
						}),
					),
			);
	}

	/**
	 * Удалить активную (ics/caldav) подписку safely: зеркало в корзину ПЕРВЫМ
	 * (пока запись ещё в списке), затем вырезать из settings, затем save с
	 * откатом при отказе (восстановить запись + rollbackSubscriptionRemoval).
	 * Общий хвост для трёх мест: кнопка «Удалить» у ICS-строки, у CalDAV-строки
	 * и выключение toggle обнаруженного календаря (§9).
	 */
	private async removeActiveSub(sub: ActiveCalendarSub): Promise<void> {
		const sync = this.plugin.desktopCalendarSync();
		// tombstone+abort ДО await, чтобы зависший fetch не воскресил зеркало.
		await sync.removeSubscription(sub);
		const subs = this.plugin.settings.externalCalendars;
		const i = subs.indexOf(sub);
		if (i >= 0) {
			subs.splice(i, 1);
			sync.configurationChanged();
		}
		try {
			await this.save();
		} catch (error) {
			if (i >= 0) {
				subs.splice(i, 0, sub);
				sync.rollbackSubscriptionRemoval(sub.id);
			}
			throw error;
		}
	}

	/**
	 * CalDAV-подписка (§9 CalDAV-заказа): имя+статус+синк/удаление на строке 1,
	 * приватность на строке 2 (fail-closed, ничего не предвыбрано пока
	 * "unconfigured"), «Включена» на строке 3 (заблокирован до явного выбора
	 * приватности), Scope на строке 4. Ни href, ни username/token сюда не
	 * попадают — только opaque collectionKey/accountId уже осевшие в sub.
	 */
	private renderCaldavSub(el: HTMLElement, sub: CalDavCalendarSub): void {
		const account = this.plugin.settings.caldavAccounts.find((a) => a.id === sub.accountId);
		const originLabel = account?.serverOrigin ?? "аккаунт недоступен";
		const row = new Setting(el)
			.setName(sub.name.trim() === "" ? "(без имени)" : sub.name)
			.setDesc(`${originLabel} · ${formatSyncStatus(sub, this.syncRuntime(sub))}`);

		row.addText((t) => {
			t.setPlaceholder("Имя");
			t.setValue(sub.name);
			// Тот же коммит-по-blur/Enter, что и у ICS (см. renderExternalSub).
			commitOnBlur(t.inputEl, async () => {
				const renamed = await commitSubName(sub, t.getValue(), {
					deleteMirror: (oldName) => {
						const sync = this.plugin.desktopCalendarSync();
						sync.configurationChanged();
						return sync.deleteMirror({ ...sub, name: oldName });
					},
					save: () => this.save(),
				});
				if (renamed) this.display();
				else t.setValue(sub.name);
			});
		});

		row.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Синхронизировать сейчас")
				.onClick(() =>
					this.reportAction("не удалось синхронизировать календарь", async () => {
						await this.plugin.desktopCalendarSync().syncById(sub.id);
						this.display();
					}),
				),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("Удалить подписку")
				.onClick(() =>
					this.reportAction("не удалось удалить подписку", async () => {
						await this.removeActiveSub(sub);
						this.display();
					}),
				),
		);

		const privacyRow = new Setting(el).setName("Приватность");
		privacyRow.addDropdown((dd) => {
			// "unconfigured" — только пока приватность реально не выбрана; после
			// первого явного выбора обратно её выбрать нельзя (§4.3).
			if (sub.privacy === "unconfigured") dd.addOption("unconfigured", "— выберите режим —");
			dd.addOption("busy", "Занятость (рекомендуется): только время");
			dd.addOption("details", "Детали: название и место");
			dd.setValue(sub.privacy);
			dd.onChange((value) =>
				this.reportChange(async () => {
					if (value !== "busy" && value !== "details") return;
					const sync = this.plugin.desktopCalendarSync();
					try {
						const result = await commitPrivacyMode(sub, value, {
							fence: () => sync.configurationChanged(),
							save: () => this.save(),
						});
						if (result === "pending-redaction") {
							new Notice(
								"GTD Flow: детальное зеркало будет зачищено перед следующей синхронизацией",
							);
							sync.configurationChanged();
						}
						if (result !== "unchanged") this.display();
					} catch {
						new Notice("GTD Flow: изменение не применено");
						dd.setValue(sub.privacy);
					}
				}),
			);
		});

		const enabledRow = new Setting(el).setName("Включена");
		enabledRow.addToggle((toggle) => {
			toggle.setValue(sub.enabled);
			// §4.3: нельзя включить синхронизацию до явного выбора приватности.
			toggle.setDisabled(sub.privacy === "unconfigured");
			toggle.onChange((value) =>
				this.reportChange(async () => {
					if (sub.privacy === "unconfigured") {
						// Defense-in-depth: setDisabled — UI-подсказка, не гарантия.
						toggle.setValue(false);
						new Notice("GTD Flow: сначала выберите режим приватности");
						return;
					}
					sub.enabled = value;
					this.plugin.desktopCalendarSync().configurationChanged();
					await this.save();
				}),
			);
		});

		const scopeRow = new Setting(el).setName("Scope");
		scopeRow.addDropdown((dd) => {
			const catalog = this.plugin.scopes.current();
			const activeScopes = catalog.scopes.filter((s) => !s.archived);
			const scopeMissing =
				sub.scopeId !== null && !activeScopes.some((s) => s.id === sub.scopeId);
			// Недоступный/архивный scope — fail-closed отображение (§4.2): показать
			// предупреждение первым пунктом и оставить его выбранным, не расскоуплять молча.
			if (scopeMissing) dd.addOption(sub.scopeId!, `⚠ ${sub.scopeId} (недоступен)`);
			dd.addOption("", "(глобально)");
			for (const s of activeScopes) dd.addOption(s.id, s.name);
			dd.setValue(sub.scopeId ?? "");
			dd.onChange((value) =>
				this.reportChange(async () => {
					sub.scopeId = value === "" ? null : value;
					this.plugin.desktopCalendarSync().configurationChanged();
					await this.save();
					// Смена scope перерисовывает зеркало на месте — без display().
				}),
			);
		});
	}

	/** One subscription: name, status, and controls; feed URL is on the next row.
	 *  с предупреждением о секретности (строка 2). */
	private renderExternalSub(el: HTMLElement, sub: IcsCalendarSub): void {
		const row = new Setting(el)
			.setName(sub.name.trim() === "" ? "(без имени)" : sub.name)
			.setDesc(formatSyncStatus(sub, this.syncRuntime(sub)));

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
					deleteMirror: (oldName) => {
						// Fence before the awaited trash operation: a fetch which resolves in
						// that gap must not recreate the old-name mirror.
						const sync = this.plugin.desktopCalendarSync();
						sync.configurationChanged();
						return sync.deleteMirror({ ...sub, name: oldName });
					},
					save: () => this.save(),
				});
				if (renamed) this.display();
				else t.setValue(sub.name); // нормализовать отображение (trim), фокус свободен
			});
		});

		row.addExtraButton((b) =>
			b
				.setIcon("refresh-cw")
				.setTooltip("Синхронизировать сейчас")
				.onClick(() =>
					this.reportAction("не удалось синхронизировать календарь", async () => {
						await this.plugin.desktopCalendarSync().syncById(sub.id);
						this.display();
					}),
				),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("Удалить подписку")
				.onClick(() =>
					this.reportAction("не удалось удалить подписку", async () => {
						await this.removeActiveSub(sub);
						this.display();
					}),
				),
		);

		const urlSetting = new Setting(el)
			.setName("Адрес ленты (.ics)")
			.setDesc(
				"Поддерживаются http(s):// и webcal:// (кнопки «Подписаться» Apple/Google — " +
					"webcal автоматически заменяется на https). Внимание: секретный ICS-адрес — это " +
					"доступ к вашему календарю на ЧТЕНИЕ. Храните его как пароль; он лежит локально в data.json. " +
					"CalDAV-аккаунты, в отличие от ICS, хранят учётные данные в SecretStorage.",
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
				this.plugin.desktopCalendarSync().configurationChanged();
				await this.save();
			});
		});
		urlSetting.settingEl.style.paddingTop = "0";
	}

	// ── CalDAV-аккаунты (§9 CalDAV-заказа) ─────────────────────────────────

	/**
	 * Реестр CalDAV-аккаунтов: заголовок, гейт по наличию SecretStorage-рантайма,
	 * строки аккаунтов и инлайн-форма добавления. Ничего секретного сюда не
	 * попадает — только origin (не identity-bearing) и opaque secretRef.
	 */
	private renderCaldavAccountsSection(el: HTMLElement): void {
		new Setting(el)
			.setName("CalDAV-аккаунты (read-only)")
			.setHeading()
			.setDesc(
				"Учётные данные хранятся в Obsidian SecretStorage (НЕ в data.json), " +
					"настраиваются отдельно на каждом устройстве; события импортируются только на чтение.",
			);

		const credentials = this.plugin.caldavCredentials;
		if (credentials === null) {
			new Setting(el)
				.setName("CalDAV недоступен")
				.setDesc("Нужен Obsidian 1.11.4+ (SecretStorage) и desktop-сборка плагина.");
			return;
		}

		for (const account of this.plugin.settings.caldavAccounts) {
			this.renderCaldavAccountRow(el, account, credentials);
		}

		if (this.addingCaldavAccount) {
			this.renderCaldavAccountDraft(el, credentials, null);
			return;
		}
		new Setting(el).addButton((b) =>
			b
				.setButtonText("Добавить CalDAV-аккаунт")
				.setCta()
				.onClick(() => {
					this.addingCaldavAccount = true;
					this.display();
				}),
		);
	}

	private renderCaldavAccountRow(
		el: HTMLElement,
		account: CalDavAccount,
		credentials: SecretStorageCredentials,
	): void {
		const hasCredential = credentials.get(account.id) !== null;
		const row = new Setting(el)
			.setName(account.serverOrigin)
			.setDesc(
				`секрет: ${account.secretRef} · ` +
					(hasCredential
						? "учётные данные заданы"
						: "⚠ учётные данные не заданы на этом устройстве"),
			);
		row.addExtraButton((b) =>
			b
				.setIcon("search")
				.setTooltip("Обнаружить календари")
				.onClick(() =>
					this.reportAction("не удалось обнаружить календари", async () => {
						await this.discoverCaldavCalendars(account, credentials);
					}),
				),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip("Отключить аккаунт")
				.onClick(() =>
					this.reportAction("аккаунт не отключён", async () => {
						await this.disconnectCaldavAccount(account, credentials);
					}),
				),
		);

		if (this.editingCaldavCredentialsFor === account.id) {
			this.renderCaldavAccountDraft(el, credentials, account);
		} else {
			new Setting(el).addButton((b) =>
				b.setButtonText("Обновить учётные данные").onClick(() => {
					this.editingCaldavCredentialsFor = account.id;
					this.display();
				}),
			);
		}

		for (const calendar of this.discovered.get(account.id) ?? []) {
			this.renderDiscoveredCalendarRow(el, account, calendar);
		}
	}

	/**
	 * Общая инлайн-форма (НЕ модал) добавления нового аккаунта / обновления
	 * учётных данных существующего. `target === null` — новый аккаунт (просит
	 * ещё и origin); иначе — только логин/токен для уже существующего.
	 * Токен идёт ТОЛЬКО через SecretComponent (masked) и никогда не эхается —
	 * после успешного сохранения виджет сбрасывается setValue("").
	 */
	private renderCaldavAccountDraft(
		el: HTMLElement,
		credentials: SecretStorageCredentials,
		target: CalDavAccount | null,
	): void {
		let originValue = "";
		let username = "";
		let token = "";
		let secretComponent: SecretComponent | null = null;

		new Setting(el).setName(
			target === null
				? "Новый CalDAV-аккаунт"
				: `Обновить учётные данные: ${target.serverOrigin}`,
		);

		if (target === null) {
			new Setting(el).setName("Адрес сервера (https-origin)").addText((t) => {
				t.setPlaceholder("https://caldav.example.com");
				t.onChange((v) => {
					originValue = v;
				});
			});
		}

		new Setting(el).setName("Логин").addText((t) => {
			t.setPlaceholder("username");
			t.onChange((v) => {
				username = v;
			});
		});

		new Setting(el).setName("OAuth-токен (пароль)").addComponent((containerEl) => {
			const component = new SecretComponent(this.app, containerEl);
			component.onChange((v) => {
				token = v;
			});
			secretComponent = component;
			return component;
		});

		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText("Сохранить аккаунт")
					.setCta()
					.onClick(() =>
						this.reportAction("аккаунт не сохранён", async () => {
							const ok =
								target === null
									? await this.commitNewCaldavAccount(
											originValue,
											username,
											token,
											credentials,
										)
									: await this.commitCaldavCredentialUpdate(
											target,
											username,
											token,
											credentials,
										);
							if (!ok) return;
							secretComponent?.setValue("");
							if (target === null) this.addingCaldavAccount = false;
							else this.editingCaldavCredentialsFor = null;
							this.display();
						}),
					),
			)
			.addButton((b) =>
				b.setButtonText("Отмена").onClick(() => {
					if (target === null) this.addingCaldavAccount = false;
					else this.editingCaldavCredentialsFor = null;
					this.display();
				}),
			);
	}

	/**
	 * Валидация + запись нового аккаунта (§9): origin невалиден или логин/токен
	 * пусты → безопасный Notice, БЕЗ мутации. setPayload бросает (SecretStorage
	 * недоступен) → Notice, БЕЗ мутации settings — секрет и запись аккаунта
	 * коммитятся только вместе.
	 */
	private async commitNewCaldavAccount(
		originRaw: string,
		username: string,
		token: string,
		credentials: SecretStorageCredentials,
	): Promise<boolean> {
		const origin = originRaw.trim();
		if (!isValidCaldavOrigin(origin)) {
			new Notice(
				"GTD Flow: некорректный адрес сервера — нужен голый https-адрес без пути и параметров",
			);
			return false;
		}
		if (username.trim() === "" || token === "") {
			new Notice("GTD Flow: укажите логин и токен");
			return false;
		}
		const accountId = genCaldavAccountId();
		const secretRef = `gtd-flow-caldav-${accountId}`;
		try {
			credentials.setPayload(secretRef, { username: username.trim(), token });
		} catch {
			new Notice("GTD Flow: SecretStorage недоступен");
			return false;
		}
		this.plugin.settings.caldavAccounts.push({
			id: accountId,
			serverOrigin: origin,
			secretRef,
		});
		await this.save();
		return true;
	}

	/**
	 * Обновление логина/токена существующего аккаунта: PRESERVES текущий кэш
	 * collections/principalPath (читаем текущий payload через get() и
	 * сливаем) — иначе перезапись потеряла бы кэш href, обнаруженный
	 * «Обнаружить календари» ранее.
	 */
	private async commitCaldavCredentialUpdate(
		account: CalDavAccount,
		username: string,
		token: string,
		credentials: SecretStorageCredentials,
	): Promise<boolean> {
		if (username.trim() === "" || token === "") {
			new Notice("GTD Flow: укажите логин и токен");
			return false;
		}
		const existing = credentials.get(account.id);
		try {
			credentials.setPayload(account.secretRef, {
				username: username.trim(),
				token,
				collections: existing?.collections,
				principalPath: existing?.principalPath,
			});
		} catch {
			new Notice("GTD Flow: SecretStorage недоступен");
			return false;
		}
		return true;
	}

	/**
	 * «Обнаружить календари» (§6/§9): гейт credential_missing БЕЗ сети; caldav-
	 * модули — динамический import (SettingsTab живёт в универсальном бандле,
	 * см. main.ts). Успех — сохранить результат в this.discovered И обновить
	 * кэш href в SecretStorage (href живёт ТОЛЬКО там, §5.1); отказ — безопасный
	 * Notice по коду, сырой текст ошибки никогда не показывается.
	 */
	private async discoverCaldavCalendars(
		account: CalDavAccount,
		credentials: SecretStorageCredentials,
	): Promise<void> {
		const credential = credentials.get(account.id);
		if (credential === null) {
			new Notice(`GTD Flow: ⚠ ${describeSyncErrorCode("credential_missing")}`);
			return;
		}
		const [{ discoverCalendars }, { createNodeHttpAdapter }] = await Promise.all([
			import("../sync/caldav/protocol"),
			import("../sync/caldav/nodeHttpAdapter"),
		]);
		let result: readonly DiscoveredCalendar[];
		try {
			result = await discoverCalendars(
				{ id: account.id, serverOrigin: account.serverOrigin },
				credential,
				createNodeHttpAdapter(),
				{ deadlineAt: Date.now() + 60_000 },
			);
		} catch (error) {
			const code = error instanceof ExternalSyncError ? error.code : "unknown";
			new Notice(`GTD Flow: ⚠ ${describeSyncErrorCode(code)}`);
			return;
		}
		this.discovered.set(account.id, result);
		const collections: Record<string, string> = { ...credential.collections };
		for (const calendar of result) collections[calendar.collectionKey] = calendar.href;
		try {
			credentials.setPayload(account.secretRef, { ...credential, collections });
		} catch {
			// Кэш href — best-effort ускоритель следующего REPORT, не источник истины;
			// discovery уже успешно, отказ кэширования не должен прятать результат.
		}
		this.display();
	}

	/** Одна обнаруженная коллекция: чекбокс подписки. Рендерит ТОЛЬКО displayName
	 *  и opaque collectionKey — href сюда не попадает никогда (§9). */
	private renderDiscoveredCalendarRow(
		el: HTMLElement,
		account: CalDavAccount,
		calendar: DiscoveredCalendar,
	): void {
		const existingSub = this.plugin.settings.externalCalendars.find(
			(sub): sub is CalDavCalendarSub =>
				sub.kind === "caldav" &&
				sub.accountId === account.id &&
				sub.collectionKey === calendar.collectionKey,
		);
		new Setting(el)
			.setName(calendar.displayName.trim() === "" ? "(без имени)" : calendar.displayName)
			.setDesc(`коллекция ${calendar.collectionKey}`)
			.addToggle((toggle) => {
				toggle.setValue(existingSub !== undefined);
				toggle.onChange((value) =>
					this.reportChange(async () => {
						if (value) {
							if (existingSub !== undefined) return;
							this.plugin.settings.externalCalendars.push({
								kind: "caldav",
								id: genSubId(),
								name:
									calendar.displayName.trim() === ""
										? "Календарь"
										: calendar.displayName,
								accountId: account.id,
								collectionKey: calendar.collectionKey,
								privacy: "unconfigured",
								enabled: false,
								scopeId: null,
								pendingRedaction: false,
								lastSyncAt: null,
								lastError: null,
								errorCode: null,
							});
							await this.save();
						} else {
							if (existingSub === undefined) return;
							await this.removeActiveSub(existingSub);
						}
						this.display();
					}),
				);
			});
	}

	/**
	 * Отключить CalDAV-аккаунт (§4.1): каскад через removeCaldavAccount с
	 * подтверждением, если есть ссылающиеся подписки. После успешного отключения
	 * ОТДЕЛЬНО (второй confirm) спрашивает про очистку секрета — осиротевшие
	 * секреты стираются только явным действием пользователя.
	 */
	private async disconnectCaldavAccount(
		account: CalDavAccount,
		credentials: SecretStorageCredentials,
	): Promise<void> {
		const sync = this.plugin.desktopCalendarSync();
		const referencingCount = this.plugin.settings.externalCalendars.filter(
			(sub) => sub.kind === "caldav" && sub.accountId === account.id,
		).length;
		const result = await removeCaldavAccount(this.plugin.settings, account.id, {
			confirmCascade: () =>
				confirm(
					this.app,
					"Отключить CalDAV-аккаунт?",
					`С аккаунтом «${account.serverOrigin}» связано подписок: ${referencingCount}. ` +
						"Их зеркала уйдут в корзину (восстановимо), а сами записи будут удалены.",
					"Отключить",
				),
			removeSubscription: (sub) => sync.removeSubscription(sub),
			rollbackRemoval: (id) => sync.rollbackSubscriptionRemoval(id),
			save: () => this.save(),
		});
		if (result.status === "refused-active-subscriptions") {
			new Notice("GTD Flow: аккаунт не отключён");
			return;
		}
		if (this.editingCaldavCredentialsFor === account.id)
			this.editingCaldavCredentialsFor = null;
		this.discovered.delete(account.id);

		const wipeSecret = await confirm(
			this.app,
			"Стереть секрет из SecretStorage?",
			`Учётные данные аккаунта «${account.serverOrigin}» будут перезаписаны пустым значением. ` +
				"Obsidian не удаляет сам идентификатор секрета — id останется в списке.",
			"Стереть",
		);
		if (wipeSecret) {
			try {
				credentials.clearPayload(account.secretRef);
			} catch {
				new Notice("GTD Flow: не удалось стереть секрет");
			}
		}
		this.display();
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
			text.onChange((raw) =>
				this.reportChange(async () => {
					const { presets, invalid } = parseDeferPresets(raw);
					errorEl.setText(
						invalid.length > 0
							? `Не распознано (формат «Метка|дни»): ${invalid.join("; ")}`
							: "",
					);
					this.plugin.settings.deferPresets = presets;
					await this.save();
				}),
			);
		});
	}

	// ── Регулярные ──────────────────────────────────────────────────────────

	private sectionRecurring(el: HTMLElement): void {
		new Setting(el).setName("Регулярные").setHeading();

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
				dd.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.recurring.catchUp =
							value === "all" || value === "none" ? value : "latest";
						await this.save();
					}),
				);
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
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.cardsFolder = value.trim();
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Ссылка на карточку в строке задачи")
			.setDesc("При создании карточки добавлять в строку задачи ссылку на неё.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.cardLinkInLine);
				toggle.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.cardLinkInLine = value;
						await this.save();
					}),
				);
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
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.defaultBoardPath = value.trim();
						await this.save();
					}),
				);
			});

		new Setting(el)
			.setName("Файл архива")
			.setDesc(
				"Куда переносятся выполненные/отменённые карточки при «Архивировать» (frontmatter gtd-archive: true).",
			)
			.addText((text) => {
				text.setPlaceholder("GTD/Archive.md");
				text.setValue(this.plugin.settings.archiveFile);
				text.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.archiveFile = value.trim();
						await this.save();
					}),
				);
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
				toggle.onChange((value) =>
					this.reportChange(async () => {
						this.plugin.settings.autoInjectId = value;
						await this.save();
					}),
				);
			});

		this.intSetting(
			new Setting(el)
				.setName("Порог виртуализации")
				.setDesc(
					"Списки длиннее порога рендерятся виртуально (быстрее на больших хранилищах).",
				),
			{
				min: 0,
				max: 100000,
				get: () => this.plugin.settings.virtualizeThreshold,
				set: (v) => (this.plugin.settings.virtualizeThreshold = v),
			},
		);

		if (this.desktopFeatures) {
			new Setting(el)
				.setName("Возврат отложенной задачи")
				.setDesc(
					"Куда «всплывает» задача, когда наступает её дата старта. " +
						"«В исходное место» — остаётся в своём файле и снова проходит запрос входящих. " +
						"«Во входящие» (по умолчанию) — снимается 🛫, снимаются теги доски, а строка " +
						"переносится в единый настроенный файл входящих.",
				)
				.addDropdown((dd) => {
					dd.addOption("origin", "В исходное место");
					dd.addOption("inbox", "Во входящие");
					dd.setValue(this.plugin.settings.promoteTo);
					dd.onChange((value) =>
						this.reportChange(async () => {
							this.plugin.settings.promoteTo = value === "inbox" ? "inbox" : "origin";
							await this.save();
						}),
					);
				});
		}

		this.intSetting(
			new Setting(el)
				.setName("Задержка переиндексации файла, мс")
				.setDesc(
					"Для продвинутых. Дебаунс реакции на правки файлов. Вступает в силу после перезапуска плагина.",
				),
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
			text.onChange((raw) =>
				this.reportChange(async () => {
					const v = parseIntInRange(raw, opts.min, opts.max);
					if (v === null) return;
					opts.set(v);
					await this.save();
				}),
			);
			text.inputEl.addEventListener("blur", () => {
				text.setValue(String(opts.get()));
			});
		});
	}

	/** Obsidian ignores callback promises; report every rejection at the boundary. */
	private reportChange(action: () => Promise<void>): void {
		reportAsync("изменение настройки не применено", action);
	}

	private reportAction(label: string, action: () => Promise<void>): void {
		reportAsync(label, action);
	}
}

/** Короткий стабильный id новой подписки (время + случайный хвост). */
function genSubId(): string {
	return `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Slug id нового CalDAV-аккаунта: строчные буквы/цифры/дефис — контракт
 *  SecretStorage-ключей (см. SecretStorageCredentials.SECRET_REF_PATTERN). */
function genCaldavAccountId(): string {
	return `caldav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Навесить коммит-по-потере-фокуса (+Enter) на текстовый инпут: во время набора
 * НИЧЕГО не сохраняется, изменения фиксируются на blur или по Enter (Enter лишь
 * снимает фокус — единый путь коммита через blur). Так поля «имя» и «адрес ленты»
 * подписок не пересоздаются на каждый символ и не теряют фокус (ср. числовые поля,
 * которые пишут валидное значение сразу, но откатывают мусор на blur — intSetting).
 */
function commitOnBlur(inputEl: HTMLInputElement, commit: () => void | Promise<void>): void {
	inputEl.addEventListener("blur", () =>
		reportAsync("изменение настройки не применено", async () => commit()),
	);
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			inputEl.blur();
		}
	});
}

/** Человекочитаемый статус подписки для описания строки. */

/**
 * Read-only, bounded view over the service-sanitized learning history. The
 * modal never reads synced files itself and never receives task/question text,
 * paths, provider metadata, run/session identifiers, or credentials.
 */
export class AiLearningHistoryModal extends Modal {
	constructor(
		app: App,
		private readonly inspection: AiFeedbackInspection,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("История обучения AI");
		this.contentEl.empty();
		const events = this.inspection.events.slice(0, AI_FEEDBACK_INSPECTION_LIMIT);
		this.contentEl.createEl("p", {
			text:
				`Показано последних событий: ${events.length} из ${this.inspection.totalEvents}. ` +
				`Пропущено более старых: ${this.inspection.omittedEvents}; повреждённых записей: ${this.inspection.invalidRecords}.`,
		});
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Текст задач и вопросов, пути, сведения о провайдере и данные авторизации здесь намеренно не показываются.",
		});
		if (events.length === 0) {
			this.contentEl.createEl("p", { text: "Событий обучения пока нет." });
			return;
		}
		for (const event of events) this.renderEvent(event);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderEvent(event: AiFeedbackInspectionEvent): void {
		const details = this.contentEl.createEl("details");
		details.createEl("summary", {
			text: `${event.createdAt} · ${event.kind} · ${event.taskId}`,
		});
		details.createEl("p", { text: `Событие: ${event.id}` });
		details.createEl("p", { text: event.detail });
		details.createEl("p", { text: "Текущее владение полями этой задачи:" });
		const provenance = details.createEl("ul");
		for (const field of event.provenance.slice(0, 5)) {
			const prediction =
				field.lastPredictionEventId === null
					? ""
					: `; последнее предсказание ${field.lastPredictionEventId}`;
			provenance.createEl("li", {
				text:
					`${field.field}: ${field.owner}, ${field.locked ? "заблокировано" : "разблокировано"}` +
					`; обновлено ${field.updatedAt}${prediction}`,
			});
		}
	}
}
