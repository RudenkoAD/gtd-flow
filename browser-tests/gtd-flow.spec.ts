import { devices, expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function expectNoAxeViolations(page: Page, selector: string): Promise<void> {
	const results = await new AxeBuilder({ page }).include(selector).analyze();
	expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe("mounted GTD Flow Svelte component gate", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/");
	});

	test("virtualizes variable-height rows without an unreachable tail and preserves keyed drafts", async ({
		page,
	}) => {
		const list = page.locator(".gtd-vlist");
		await expect(list).toBeVisible();

		await expect
			.poll(async () =>
				list.evaluate(async (element) => {
					element.scrollTop = element.scrollHeight;
					element.dispatchEvent(new Event("scroll"));
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					return (
						element.querySelector('[data-row-id="row-35"]') !== null &&
						Math.ceil(element.scrollTop + element.clientHeight) >=
							Math.floor(element.scrollHeight)
					);
				}),
			)
			.toBe(true);
		await expect(page.locator('[data-row-id="row-35"]')).toBeVisible();

		await list.evaluate((element) => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event("scroll"));
		});
		const firstDraft = page.getByTestId("draft-row-0");
		await expect(firstDraft).toBeVisible();
		await firstDraft.fill("draft survives keyed reorder");
		await page.getByTestId("swap-leading-rows").click();
		await expect(page.getByTestId("draft-row-0")).toHaveValue("draft survives keyed reorder");
		await expectNoAxeViolations(page, '[data-testid="virtual-list-fixture"]');
	});

	test("calendar day supports keyboard quick-add and announces an async write failure", async ({
		page,
	}) => {
		const day = page.getByRole("gridcell", { name: /День 2026-07-28/ });
		await day.focus();
		await page.keyboard.press("Enter");

		const taskInput = page.getByRole("textbox", { name: "Новая задача на 2026-07-28" });
		await expect(taskInput).toBeFocused();
		await taskInput.fill("Persist this failed draft");
		await taskInput.press("Enter");

		await expect(page.locator("#gtd-browser-notices")).toContainText(
			"не удалось добавить задачу",
		);
		await expect(page.getByRole("textbox", { name: "Новая задача на 2026-07-28" })).toHaveValue(
			"Persist this failed draft",
		);
		await expectNoAxeViolations(page, '[data-testid="calendar-day-fixture"]');
	});

	test("a rejected drop is announced through the mounted DnD error boundary", async ({
		page,
	}) => {
		const source = page.getByTestId("rejected-drop-source");
		const target = page.getByTestId("rejected-drop-target");
		await source.scrollIntoViewIfNeeded();
		const sourceBox = await source.boundingBox();
		const targetBox = await target.boundingBox();
		expect(sourceBox).not.toBeNull();
		expect(targetBox).not.toBeNull();
		if (sourceBox === null || targetBox === null) throw new Error("DnD fixture is not visible");

		await source.dispatchEvent("pointerdown", {
			button: 0,
			pointerType: "mouse",
			clientX: sourceBox.x + sourceBox.width / 2,
			clientY: sourceBox.y + sourceBox.height / 2,
		});
		await page.mouse.move(
			targetBox.x + targetBox.width / 2,
			targetBox.y + targetBox.height / 2,
		);
		await expect(target).toHaveClass(/gtd-dnd-over/);
		await page.mouse.up();

		await expect(page.locator("#gtd-browser-notices")).toContainText(
			"не удалось перенести карточку",
		);
		await expectNoAxeViolations(page, '[data-testid="dnd-error-fixture"]');
	});

	test("opens task details only from non-title affordances and saves one atomic update", async ({
		page,
	}) => {
		const fixture = page.getByTestId("task-details-fixture");
		const card = fixture.locator(".gtd-task-card");
		const dialog = page.getByRole("dialog", { name: "Задача" });

		const title = card.locator(".gtd-task-desc");
		await title.click();
		await expect(dialog).toHaveCount(0);

		const foreignTargets = await fixture.evaluate((element) => {
			const frame = document.createElement("iframe");
			frame.hidden = true;
			element.append(frame);
			const foreignDocument = frame.contentDocument;
			const titleRoot = element.querySelector(".gtd-task-desc");
			const cardRoot = element.querySelector(".gtd-task-card");
			if (foreignDocument === null || titleRoot === null || cardRoot === null) {
				throw new Error("cross-realm task-card fixture is unavailable");
			}

			const foreignTitle = foreignDocument.createElement("span");
			foreignTitle.dataset.testid = "foreign-title-target";
			foreignTitle.textContent = " foreign title target";
			titleRoot.append(foreignTitle);

			const foreignControl = foreignDocument.createElement("button");
			foreignControl.dataset.testid = "foreign-control-target";
			foreignControl.type = "button";
			foreignControl.textContent = "Foreign control target";
			cardRoot.append(foreignControl);

			return {
				titleIsForeign: !(foreignTitle instanceof Element),
				controlIsForeign: !(foreignControl instanceof Element),
			};
		});
		expect(foreignTargets).toEqual({ titleIsForeign: true, controlIsForeign: true });
		await fixture.getByTestId("foreign-title-target").click();
		await fixture.getByTestId("foreign-control-target").click();
		await expect(dialog).toHaveCount(0);

		const kanbanFixture = page.getByTestId("kanban-popout-control-fixture");
		const kanbanControlIsForeign = await kanbanFixture.evaluate((element) => {
			const frame = document.createElement("iframe");
			frame.hidden = true;
			element.append(frame);
			const foreignDocument = frame.contentDocument;
			const taskCard = element.querySelector(".gtd-task-card");
			if (foreignDocument === null || taskCard === null) {
				throw new Error("cross-realm kanban fixture is unavailable");
			}
			const control = foreignDocument.createElement("button");
			control.type = "button";
			control.dataset.testid = "foreign-kanban-control";
			control.textContent = "Foreign Kanban control";
			taskCard.append(control);
			return !(control instanceof Element);
		});
		expect(kanbanControlIsForeign).toBe(true);
		await kanbanFixture.getByTestId("foreign-kanban-control").click();
		await expect(kanbanFixture.getByTestId("kanban-drag-start-count")).toHaveText("0");
		await expect(dialog).toHaveCount(0);

		await title.dblclick();
		const inlineTitle = title.locator("input.gtd-task-edit");
		await expect(inlineTitle).toHaveValue("Browser details task");
		await expect(dialog).toHaveCount(0);
		await inlineTitle.press("Escape");
		await expect(inlineTitle).toHaveCount(0);
		await expect(title).toContainText("Browser details task");

		await fixture.getByRole("checkbox", { name: "Выполнено" }).click();
		await fixture.getByRole("button", { name: "Чеклист карточки: 1 из 2" }).click();
		await fixture.getByRole("button", { name: "Меню задачи" }).click();
		await expect(dialog).toHaveCount(0);

		const box = await card.boundingBox();
		expect(box).not.toBeNull();
		if (box === null) throw new Error("task details card is not visible");
		const dragStart = { x: box.x + 2, y: box.y + box.height - 2 };
		await page.mouse.move(dragStart.x, dragStart.y);
		await page.mouse.down();
		await page.mouse.move(dragStart.x + 10, dragStart.y);
		await page.mouse.up();
		await expect(dialog).toHaveCount(0);

		await card.click({ position: { x: 2, y: box.height - 2 } });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Отмена" }).click();
		await expect(dialog).toHaveCount(0);

		await card.locator(".gtd-task-metadata-badge").first().click();
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Отмена" }).click();

		const detailsButton = fixture.getByRole("button", {
			name: "Открыть сведения и редактирование задачи",
		});
		await detailsButton.focus();
		await detailsButton.press("Enter");
		await expect(dialog).toBeVisible();
		await expectNoAxeViolations(page, '[role="dialog"]');

		await dialog.getByLabel("Название").fill("Edited browser details task");
		await dialog.getByLabel("⏱ Длительность, минуты").fill("120");
		await dialog.getByLabel("🧭 Scope").selectOption("life");
		await dialog.getByRole("button", { name: "Сохранить" }).click();

		await expect(dialog).toHaveCount(0);
		await expect(fixture.getByTestId("task-details-apply-count")).toHaveText("1");
		const recorded = JSON.parse(
			(await fixture.getByTestId("task-details-last-update").textContent()) ?? "null",
		) as unknown;
		expect(recorded).toEqual({
			ordinaryTypes: ["set-text"],
			metadataPatch: { durationMinutes: 120, scopeId: "life" },
		});
	});

	test("locks the task-details draft while saving and handles post-write feedback recovery", async ({
		page,
	}) => {
		const fixture = page.getByTestId("task-details-fixture");
		const dialog = page.getByRole("dialog", { name: "Задача" });
		const detailsButton = fixture.getByRole("button", {
			name: "Открыть сведения и редактирование задачи",
		});

		await fixture.getByTestId("task-details-pending-mode").click();
		await detailsButton.click();
		await dialog.getByLabel("Название").fill("Draft kept after failure");
		await dialog.getByRole("button", { name: "Сохранить" }).click();

		const formControls = dialog.locator("form input, form select, form button");
		const controlCount = await formControls.count();
		for (let index = 0; index < controlCount; index++) {
			await expect(formControls.nth(index)).toBeDisabled();
		}
		await dialog.getByRole("button", { name: "Закрыть окно" }).click();
		await expect(dialog).toBeVisible();
		await expect(dialog.getByLabel("Название")).toHaveValue("Draft kept after failure");

		await page.evaluate(() => {
			window.dispatchEvent(new Event("gtd-browser-resolve-task-details-save"));
		});
		await expect(dialog.getByRole("alert")).toHaveText(
			"Не удалось сохранить: Выбранный scope больше не активен. Выберите другой scope и повторите сохранение.",
		);
		await expect(dialog.getByLabel("Название")).toHaveValue("Draft kept after failure");
		await expect(dialog.getByLabel("Название")).toBeEnabled();
		await expect(dialog.getByRole("button", { name: "Отмена" })).toBeEnabled();

		const dueTime = dialog.getByLabel("📅 Срок: время");
		await dueTime.fill("09:00");
		await dialog.getByLabel("📅 Срок", { exact: true }).fill("");
		await expect(dueTime).toHaveValue("");
		await expect(dialog.getByRole("alert")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Отмена" }).click();

		await fixture.getByTestId("task-details-feedback-warning-mode").click();
		await detailsButton.click();
		await dialog.getByLabel("Название").fill("Saved despite feedback warning");
		await dialog.getByRole("button", { name: "Сохранить" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator("#gtd-browser-notices")).toHaveText(
			"GTD Flow: задача сохранена, но истории обучения требуется восстановление.",
		);
	});

	test("integrates inbox processing, linked-field reprocessing, and user locks through visible UI", async ({
		page,
	}) => {
		const fixture = page.getByTestId("ai-fixture");
		await expect(fixture.getByRole("heading", { name: "GTD AI" })).toBeVisible();
		await fixture.getByRole("button", { name: "Process inbox with AI" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Provisional values applied",
		);
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText(
			"Duration 90 Cognitive 4 Emotional 2 Physical 0 Scope work",
		);
		await expect(fixture.getByText("Does this include review time?")).toBeVisible();
		await expect(fixture.getByText("Затрагивает: duration")).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText(
			"Last runtime fields all estimate fields",
		);

		await fixture.getByRole("button", { name: "Correct duration to 120 minutes" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Duration corrected and locked by user",
		);
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Duration 120");
		await expect(fixture.getByText("Does this include review time?")).toHaveCount(0);
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText(
			"Duration 120 Cognitive 4 Emotional 2 Physical 0 Scope work Last runtime fields all estimate fields",
		);
		await expectNoAxeViolations(page, '[data-testid="ai-fixture"]');
	});

	test("integrates rate-limit retry and tool approval with one-shot undo through the AI UI", async ({
		page,
	}) => {
		const fixture = page.getByTestId("ai-fixture");
		await expect(fixture.getByRole("heading", { name: "GTD AI" })).toBeVisible();
		await fixture.getByRole("button", { name: "Process inbox with AI" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Provisional values applied",
		);

		await fixture.getByRole("button", { name: "Trigger rate-limited run" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Rate limited — waiting for explicit retry",
		);
		const queuedRuns = fixture.getByLabel("Обработка входящих в очереди");
		await expect(queuedRuns).toContainText("Ждём свободного места: 1 (rate-limited)");
		await expect(queuedRuns.getByRole("button")).toHaveCount(0);
		await expect(queuedRuns).toContainText(
			"Повторить ожидающие задания можно из палитры команд.",
		);
		await fixture.getByRole("button", { name: "Retry rate-limited run" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Explicit retry succeeded",
		);
		await expect(fixture.getByLabel("Обработка входящих в очереди")).toHaveCount(0);

		const composer = fixture.getByRole("textbox", { name: "Сообщение" });
		await composer.fill("Create a follow-up");
		await composer.press("Enter");
		await expect(fixture.getByText("Create task")).toBeVisible();
		await expect(fixture.getByRole("button", { name: "Отменить" })).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Created tasks 1");
		await fixture.getByRole("button", { name: "Отменить" }).click();
		await expect(fixture.getByText("Undone")).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Created tasks 0");

		await composer.fill("Delete the task");
		await composer.press("Enter");
		await expect(fixture.getByRole("heading", { name: "Нужно подтверждение" })).toBeVisible();
		await expect(fixture.getByText("Delete task task-1")).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Task deleted no");
		await fixture.getByRole("button", { name: "Отклонить" }).click();
		await expect(fixture.getByText("Delete task task-1")).toHaveCount(0);
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Task deleted no");
		await expectNoAxeViolations(page, '[data-testid="ai-fixture"]');
	});
});

test.describe("phone-sized GTD Flow UI", () => {
	test("keeps calendar, recurring tasks, and the task editor touch-safe", async ({ browser }) => {
		const context = await browser.newContext({ ...devices["Pixel 5"] });
		const page = await context.newPage();
		try {
			await page.goto("/");

			const calendar = page.getByTestId("mobile-calendar-toolbar-fixture");
			const toolbar = calendar.locator(".gtd-cal-toolbar");
			await expect(toolbar).toBeVisible();
			expect(
				await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
			).toBe(true);
			const calendarButtons = toolbar.getByRole("button");
			for (let index = 0; index < (await calendarButtons.count()); index++) {
				const box = await calendarButtons.nth(index).boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			}
			await expect(
				toolbar.getByRole("button", { name: "День", exact: true }),
			).toHaveAttribute("aria-pressed", "true");
			await toolbar.getByRole("button", { name: "Агенда", exact: true }).click();
			await expect(calendar.getByTestId("mobile-calendar-mode")).toHaveText("agenda");

			const recurring = page.getByTestId("mobile-recurring-fixture");
			const recurringView = recurring.locator(".gtd-recurring");
			await expect(recurring.getByText(/deliberately long recurring task/u)).toBeVisible();
			expect(
				await recurringView.evaluate(
					(element) => element.scrollWidth <= element.clientWidth + 1,
				),
			).toBe(true);
			const recurringButtons = recurring.getByRole("button");
			for (let index = 0; index < (await recurringButtons.count()); index++) {
				const box = await recurringButtons.nth(index).boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			}

			const inbox = page.getByTestId("mobile-inbox-fixture");
			const inboxView = inbox.locator(".gtd-inbox");
			expect(
				await inboxView.evaluate(
					(element) => element.scrollWidth <= element.clientWidth + 1,
				),
			).toBe(true);
			for (const label of ["Фильтр входящих", "Новая задача"] as const) {
				const box = await inbox.getByLabel(label).boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			}

			const detailsFixture = page.getByTestId("task-details-fixture");
			const card = detailsFixture.locator(".gtd-task-card");
			await expect(card).toHaveClass(/is-phone/u);
			expect(
				await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
			).toBe(true);
			const detailsButton = detailsFixture.getByRole("button", {
				name: "Открыть сведения и редактирование задачи",
			});
			const detailsButtonBox = await detailsButton.boundingBox();
			expect(detailsButtonBox?.width ?? 0).toBeGreaterThanOrEqual(44);
			expect(detailsButtonBox?.height ?? 0).toBeGreaterThanOrEqual(44);
			const cardBox = await card.boundingBox();
			expect(cardBox).not.toBeNull();
			if (cardBox === null) throw new Error("phone task card is not visible");
			await page.mouse.move(cardBox.x + 2, cardBox.y + cardBox.height - 2);
			await page.mouse.down();
			await page.waitForTimeout(500);
			await page.mouse.up();
			await expect(page.getByRole("dialog", { name: "Задача" })).toHaveCount(0);
			await detailsButton.click();

			const dialog = page.getByRole("dialog", { name: "Задача" });
			await expect(dialog).toBeVisible();
			expect(
				await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
			).toBe(true);
			const editorControls = dialog.locator(
				'form input:not([type="checkbox"]), form select, form button',
			);
			for (let index = 0; index < (await editorControls.count()); index++) {
				const box = await editorControls.nth(index).boundingBox();
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
			}
			const dueDateBox = await dialog.getByLabel("📅 Срок", { exact: true }).boundingBox();
			const dueTimeBox = await dialog.getByLabel("📅 Срок: время").boundingBox();
			expect(dueDateBox).not.toBeNull();
			expect(dueTimeBox).not.toBeNull();
			expect(dueTimeBox?.y).toBeGreaterThan((dueDateBox?.y ?? 0) + 1);
			await expectNoAxeViolations(page, '[role="dialog"]');
		} finally {
			await context.close();
		}
	});
});
