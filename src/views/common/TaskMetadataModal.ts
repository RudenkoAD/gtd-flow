import { Modal, Notice, type App } from "obsidian";
import { INTENSITY_ANCHORS } from "../../core/estimates/format";
import type { EstimatePatch } from "../../core/estimates/provenance";
import type { Task } from "../../core/model/Task";
import { activeScopes, type ScopeCatalog } from "../../core/scope/scope";
import {
	metadataDraftFromTask,
	metadataPatchFromDraft,
	type MetadataEditorField,
	type TaskMetadataDraft,
} from "./taskMetadata";

/** One submit produces one PatchTaskMetadata intent for all changed fields. */
export class TaskMetadataModal extends Modal {
	constructor(
		app: App,
		private readonly task: Task,
		private readonly catalog: ScopeCatalog,
		private readonly onSubmit: (patch: EstimatePatch) => void,
		private readonly focusField?: MetadataEditorField,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText("Duration, intensity, and scope");
		const draft = metadataDraftFromTask(this.task);
		const form = this.contentEl.createEl("form", { cls: "gtd-metadata-editor" });
		form.style.display = "grid";
		form.style.gap = "10px";

		const duration = this.addNumberField(
			form,
			"duration",
			"Duration (minutes)",
			draft.durationMinutes,
			5,
			"Five-minute increments below 24h; whole-day increments from 24h. Blank clears it.",
		);
		const cognitive = this.addIntensityField(
			form,
			"cognitive",
			"Cognitive intensity",
			draft.cognitiveIntensity,
		);
		const emotional = this.addIntensityField(
			form,
			"emotional",
			"Emotional intensity",
			draft.emotionalIntensity,
		);
		const physical = this.addIntensityField(
			form,
			"physical",
			"Physical intensity",
			draft.physicalIntensity,
		);
		const scope = this.addScopeField(form, draft);

		const submit = (): void => {
			const next: TaskMetadataDraft = {
				durationMinutes: duration.value,
				cognitiveIntensity: cognitive.value,
				emotionalIntensity: emotional.value,
				physicalIntensity: physical.value,
				scopeId: scope.value,
			};
			try {
				const patch = metadataPatchFromDraft(this.task, next);
				this.close();
				if (Object.keys(patch).length > 0) this.onSubmit(patch);
			} catch (error) {
				new Notice(`GTD Flow: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const footer = form.createDiv();
		footer.style.display = "flex";
		footer.style.justifyContent = "flex-end";
		footer.style.gap = "8px";
		const cancel = footer.createEl("button", {
			text: "Cancel",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.close());
		footer.createEl("button", {
			text: "Save",
			cls: "mod-cta",
			attr: { type: "submit" },
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			submit();
		});

		(
			({ duration, cognitive, emotional, physical, scope })[this.focusField ?? "duration"] ??
			duration
		).focus();
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private addNumberField(
		parent: HTMLElement,
		field: string,
		label: string,
		value: string,
		step: number,
		help: string,
	): HTMLInputElement {
		const row = parent.createDiv();
		const id = `gtd-metadata-${field}`;
		row.createEl("label", { text: label, attr: { for: id } });
		const input = row.createEl("input", {
			type: "number",
			value,
			attr: { id, min: "5", step: String(step) },
		});
		row.createDiv({ text: help, cls: "setting-item-description" });
		return input;
	}

	private addIntensityField(
		parent: HTMLElement,
		field: "cognitive" | "emotional" | "physical",
		label: string,
		value: string,
	): HTMLSelectElement {
		const row = parent.createDiv();
		const id = `gtd-metadata-${field}`;
		row.createEl("label", { text: label, attr: { for: id } });
		const select = row.createEl("select", { attr: { id } });
		select.createEl("option", { text: "Not set (clear)", value: "" });
		for (let level = 0; level <= 5; level++) {
			select.createEl("option", {
				text: `${level} — ${INTENSITY_ANCHORS[field][level as 0 | 1 | 2 | 3 | 4 | 5]}`,
				value: String(level),
			});
		}
		select.value = value;
		return select;
	}

	private addScopeField(parent: HTMLElement, draft: TaskMetadataDraft): HTMLSelectElement {
		const row = parent.createDiv();
		const id = "gtd-metadata-scope";
		row.createEl("label", { text: "Scope", attr: { for: id } });
		const select = row.createEl("select", { attr: { id } });
		select.createEl("option", { text: "No scope (clear)", value: "" });
		for (const scope of activeScopes(this.catalog)) {
			select.createEl("option", { text: scope.name, value: scope.id });
		}
		// Archived or missing existing IDs remain visible and may be explicitly cleared.
		if (
			draft.scopeId !== "" &&
			!activeScopes(this.catalog).some((scope) => scope.id === draft.scopeId)
		) {
			select.createEl("option", {
				text: `${draft.scopeId} (unavailable)`,
				value: draft.scopeId,
			});
		}
		select.value = draft.scopeId;
		return select;
	}
}
