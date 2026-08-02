/**
 * Восстановление повреждённого каталога scope — единственный выход из
 * «каталог scope повреждён — изменения заблокированы» без файлового менеджера.
 * Один и тот же путь используют команда палитры и кнопка в настройках.
 */
import { Notice, type App } from "obsidian";
import { SCOPE_CATALOG_PATH, type ScopeCatalogService } from "../../services/ScopeCatalogService";
import { confirm } from "./ConfirmModal";

/** true — каталог пересоздан (вызывающий UI должен перерисоваться). */
export async function recreateScopeCatalogWithConfirm(
	app: App,
	scopes: ScopeCatalogService,
): Promise<boolean> {
	const known = scopes.current().scopes.length;
	// При повреждении current() пуст, поэтому предупреждение о потере показываем
	// только когда терять действительно есть что (валидный каталог со scope).
	const loss =
		known === 0
			? ""
			: ` Сейчас в каталоге ${known} scope — они исчезнут из списка, метки 🧭 в задачах останутся как есть.`;
	const confirmed = await confirm(
		app,
		"Пересоздать каталог scope?",
		`Файл ${SCOPE_CATALOG_PATH} будет сохранён рядом как .bak-…, а на его место ляжет пустой валидный каталог.${loss}`,
		"Пересоздать",
	);
	if (!confirmed) return false;
	const result = await scopes.recreate();
	new Notice(
		result.backupPath === null
			? "GTD Flow: каталог scope пересоздан"
			: `GTD Flow: каталог scope пересоздан, старый сохранён в ${result.backupPath}`,
	);
	return true;
}
