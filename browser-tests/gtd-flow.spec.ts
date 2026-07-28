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

		await list.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(page.locator('[data-row-id="row-35"]')).toBeVisible();
		await expect
			.poll(() =>
				list.evaluate(
					(element) =>
						Math.ceil(element.scrollTop + element.clientHeight) >=
						Math.floor(element.scrollHeight),
				),
			)
			.toBe(true);

		await list.evaluate((element) => {
			element.scrollTop = 0;
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

		await expect(page.getByRole("status")).toContainText("не удалось добавить задачу");
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

		await expect(page.getByRole("status")).toContainText("не удалось перенести карточку");
		await expectNoAxeViolations(page, '[data-testid="dnd-error-fixture"]');
	});
});
