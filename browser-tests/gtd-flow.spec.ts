import { expect, test, type Page } from "@playwright/test";
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
		await expect(fixture.getByText("Affects: duration")).toBeVisible();
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
		await expect(fixture.getByLabel("Waiting inbox processing runs")).toContainText(
			"Waiting for free capacity: 1 (rate-limited)",
		);
		await expect(fixture.getByRole("button", { name: "Retry waiting runs" })).toHaveCount(0);
		await expect(fixture.getByLabel("Waiting inbox processing runs")).toContainText(
			"Use the command palette to retry waiting AI jobs.",
		);
		await fixture.getByRole("button", { name: "Retry rate-limited run" }).click();
		await expect(fixture.getByTestId("ai-runtime-status")).toHaveText(
			"Explicit retry succeeded",
		);
		await expect(fixture.getByLabel("Waiting inbox processing runs")).toHaveCount(0);

		const composer = fixture.getByRole("textbox", { name: "Message" });
		await composer.fill("Create a follow-up");
		await composer.press("Enter");
		await expect(fixture.getByText("Create task")).toBeVisible();
		await expect(fixture.getByRole("button", { name: "Undo" })).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Created tasks 1");
		await fixture.getByRole("button", { name: "Undo" }).click();
		await expect(fixture.getByText("Undone")).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Created tasks 0");

		await composer.fill("Delete the task");
		await composer.press("Enter");
		await expect(fixture.getByRole("heading", { name: "Approval required" })).toBeVisible();
		await expect(fixture.getByText("Delete task task-1")).toBeVisible();
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Task deleted no");
		await fixture.getByRole("button", { name: "Reject" }).click();
		await expect(fixture.getByText("Delete task task-1")).toHaveCount(0);
		await expect(fixture.getByLabel("Atomic task writeback")).toContainText("Task deleted no");
		await expectNoAxeViolations(page, '[data-testid="ai-fixture"]');
	});
});
