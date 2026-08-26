/**
 * SecretStorage-адаптер учётных данных CalDAV (§5.1 CalDAV-заказа). Единственное
 * место, которое знает про Obsidian SecretStorage; протокольный код видит
 * только CalDavCredentialPort (см. src/sync/caldav/httpPort.ts).
 *
 * SecretStorage синхронна и здесь НЕ кэшируется: секрет читается заново на
 * каждый get(), чтобы ротация значения через UI настроек подхватывалась уже
 * следующим проходом синка. delete-метода в Obsidian 1.11.4 нет (см.
 * obsidian.d.ts) — clearPayload() документированно отступает от §4.1 заказа:
 * перезаписывает секрет пустой строкой, id аккаунта остаётся в listSecrets().
 */
import type { CalDavCredential, CalDavCredentialPort } from "../sync/caldav/httpPort";
import type { CalDavAccount } from "../settings/Settings";

/** Минимальный срез Obsidian SecretStorage (синхронный, delete-метода нет). */
export interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

/** Контракт id/secretRef: строчные буквы, цифры, дефис-разделитель (§4.1). */
const SECRET_REF_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Парсит полезную нагрузку секрета. Fail-closed: любое расхождение с ожидаемой
 * формой (не JSON, не объект, отсутствующие/пустые обязательные поля) — null,
 * без исключений и без утечки сырого значения в ошибку/лог. Опциональные поля
 * при неверной форме просто отбрасываются — credential остаётся валидным.
 */
function parseCredential(raw: string): CalDavCredential | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(parsed)) return null;

	const { username, token } = parsed;
	if (typeof username !== "string" || username.length === 0) return null;
	if (typeof token !== "string" || token.length === 0) return null;

	const credential: CalDavCredential = { username, token };

	const collectionsRaw = parsed.collections;
	if (isPlainObject(collectionsRaw)) {
		const collections: Record<string, string> = {};
		for (const [key, value] of Object.entries(collectionsRaw)) {
			if (typeof value === "string") collections[key] = value;
		}
		credential.collections = collections;
	}

	const principalPath = parsed.principalPath;
	if (typeof principalPath === "string" && principalPath.startsWith("/")) {
		credential.principalPath = principalPath;
	}

	return credential;
}

/**
 * Рантайм-проверка формы SecretStorage поверх `app` (defense-in-depth для
 * сборок ниже 1.11.4, где API мог отсутствовать целиком): возвращает
 * `app.secretStorage`, только если на нём реально есть все три метода
 * контракта; иначе null.
 */
export function secretStorageOf(app: unknown): SecretStorageLike | null {
	if (typeof app !== "object" || app === null) return null;
	const storage = (app as { secretStorage?: unknown }).secretStorage;
	if (typeof storage !== "object" || storage === null) return null;

	const candidate = storage as Partial<SecretStorageLike>;
	const hasApi =
		typeof candidate.setSecret === "function" &&
		typeof candidate.getSecret === "function" &&
		typeof candidate.listSecrets === "function";
	return hasApi ? (storage as SecretStorageLike) : null;
}

/**
 * Реализация CalDavCredentialPort поверх Obsidian SecretStorage (§5.1 заказа).
 * `accounts` — геттер живого реестра caldavAccounts из настроек: резолвится
 * на каждый вызов, поэтому переименование/удаление аккаунта видно немедленно.
 */
export class SecretStorageCredentials implements CalDavCredentialPort {
	constructor(
		private readonly storage: SecretStorageLike | null,
		private readonly accounts: () => readonly CalDavAccount[],
	) {}

	/**
	 * Возвращает распарсенный секрет аккаунта или null (состояние
	 * credential_missing). Никогда не бросает: недоступное хранилище,
	 * неизвестный accountId, невалидный secretRef, битый JSON или неверная
	 * форма — всё fail-closed null. Хранилище читается заново при каждом
	 * вызове (без кэша), см. заголовок файла.
	 */
	get(accountId: string): CalDavCredential | null {
		if (this.storage === null) return null;

		const account = this.accounts().find((candidate) => candidate.id === accountId);
		if (account === undefined) return null;
		if (!SECRET_REF_PATTERN.test(account.secretRef)) return null;

		const raw = this.storage.getSecret(account.secretRef);
		if (raw === null || raw === "") return null;

		return parseCredential(raw);
	}

	/**
	 * Записать/обновить полезную нагрузку секрета аккаунта (для UI настройки
	 * и кэша href при discovery). Бросает при невалидном secretRef или
	 * недоступном хранилище — ошибка записи никогда не проглатывается молча.
	 */
	setPayload(secretRef: string, payload: CalDavCredential): void {
		if (!SECRET_REF_PATTERN.test(secretRef)) throw new Error("invalid-secret-ref");
		if (this.storage === null) throw new Error("secret-storage-unavailable");
		this.storage.setSecret(secretRef, JSON.stringify(payload));
	}

	/**
	 * «Удалить» секрет насколько позволяет API (delete отсутствует в Obsidian
	 * 1.11.4): перезаписать пустой строкой; id останется в listSecrets —
	 * задокументированное отступление от §4.1 заказа. Последующий get() для
	 * этого secretRef вернёт null (пустая строка трактуется как отсутствие
	 * секрета).
	 */
	clearPayload(secretRef: string): void {
		if (!SECRET_REF_PATTERN.test(secretRef)) throw new Error("invalid-secret-ref");
		if (this.storage === null) throw new Error("secret-storage-unavailable");
		this.storage.setSecret(secretRef, "");
	}
}
