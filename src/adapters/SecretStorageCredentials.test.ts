/**
 * SecretStorageCredentials — фейковый SecretStorageLike поверх Map, БЕЗ
 * импорта 'obsidian': реализация видит его только как узкий структурный тип,
 * поэтому голого node-двойника достаточно (см. модульный докблок адаптера).
 * Покрытие: fail-closed форма секрета, отсутствие кэша, гварды до обращения
 * к хранилищу, отсутствие delete в SecretStorage (§4.1 заказа).
 */
import { describe, expect, it, vi } from "vitest";
import type { CalDavAccount } from "../settings/Settings";
import type { SecretStorageLike } from "./SecretStorageCredentials";
import { SecretStorageCredentials, secretStorageOf } from "./SecretStorageCredentials";

function makeStorage(initial: Record<string, string> = {}): SecretStorageLike {
	const map = new Map(Object.entries(initial));
	return {
		setSecret(id: string, secret: string): void {
			map.set(id, secret);
		},
		getSecret(id: string): string | null {
			return map.get(id) ?? null;
		},
		listSecrets(): string[] {
			return [...map.keys()];
		},
	};
}

function account(overrides: Partial<CalDavAccount> = {}): CalDavAccount {
	return {
		id: "acc-1",
		serverOrigin: "https://caldav.example",
		secretRef: "acc-1",
		...overrides,
	};
}

describe("SecretStorageCredentials.get", () => {
	it("возвращает распарсенный секрет и не делится ссылкой между вызовами", () => {
		const storage = makeStorage({
			"acc-1": JSON.stringify({
				username: "пользователь",
				token: "y0_x",
				collections: { "ck-1": "/cal/a/" },
				principalPath: "/principals/u/",
			}),
		});
		const port = new SecretStorageCredentials(storage, () => [account()]);

		const first = port.get("acc-1");
		expect(first).toEqual({
			username: "пользователь",
			token: "y0_x",
			collections: { "ck-1": "/cal/a/" },
			principalPath: "/principals/u/",
		});

		// Мутация возвращённого объекта не должна повлиять на следующий get():
		// каждый вызов парсит JSON заново, никакой общей ссылки нет.
		if (first?.collections !== undefined) {
			first.collections["ck-1"] = "mutated";
			first.username = "испорчено";
		}

		const second = port.get("acc-1");
		expect(second).toEqual({
			username: "пользователь",
			token: "y0_x",
			collections: { "ck-1": "/cal/a/" },
			principalPath: "/principals/u/",
		});
	});

	it("гварды до хранилища: неизвестный accountId -> null", () => {
		const storage = makeStorage({ "acc-1": JSON.stringify({ username: "u", token: "t" }) });
		const port = new SecretStorageCredentials(storage, () => [account()]);
		expect(port.get("acc-missing")).toBeNull();
	});

	it("гварды до хранилища: storage === null -> null", () => {
		const port = new SecretStorageCredentials(null, () => [account()]);
		expect(port.get("acc-1")).toBeNull();
	});

	it.each(["Не слаг", "UPPER", ""])(
		"невалидный secretRef %j -> null, getSecret не вызывается",
		(secretRef) => {
			const storage = makeStorage();
			const getSecretSpy = vi.spyOn(storage, "getSecret");
			const port = new SecretStorageCredentials(storage, () => [account({ secretRef })]);

			expect(port.get("acc-1")).toBeNull();
			expect(getSecretSpy).not.toHaveBeenCalled();
		},
	);

	it("getSecret вернул null -> null", () => {
		const storage = makeStorage();
		const port = new SecretStorageCredentials(storage, () => [account()]);
		expect(port.get("acc-1")).toBeNull();
	});

	it("getSecret вернул пустую строку -> null", () => {
		const storage = makeStorage({ "acc-1": "" });
		const port = new SecretStorageCredentials(storage, () => [account()]);
		expect(port.get("acc-1")).toBeNull();
	});

	describe("fail-closed на битой форме payload'а", () => {
		const portWith = (raw: string): SecretStorageCredentials =>
			new SecretStorageCredentials(makeStorage({ "acc-1": raw }), () => [account()]);

		it("не JSON -> null", () => {
			expect(portWith("not json").get("acc-1")).toBeNull();
		});

		it("JSON-примитив (не объект) -> null", () => {
			expect(portWith("42").get("acc-1")).toBeNull();
		});

		it("нет token -> null", () => {
			expect(portWith(JSON.stringify({ username: "u" })).get("acc-1")).toBeNull();
		});

		it("пустой username -> null", () => {
			const raw = JSON.stringify({ username: "", token: "t" });
			expect(portWith(raw).get("acc-1")).toBeNull();
		});

		it("token не строка -> null", () => {
			const raw = JSON.stringify({ username: "u", token: 123 });
			expect(portWith(raw).get("acc-1")).toBeNull();
		});

		it("collections с нестроковым значением: элемент отброшен, валидные остаются", () => {
			const raw = JSON.stringify({
				username: "u",
				token: "t",
				collections: { good: "/a/", bad: 1 },
			});
			expect(portWith(raw).get("acc-1")).toEqual({
				username: "u",
				token: "t",
				collections: { good: "/a/" },
			});
		});

		it("collections как массив: поле отброшено целиком, credential валиден", () => {
			const raw = JSON.stringify({ username: "u", token: "t", collections: ["/a/"] });
			expect(portWith(raw).get("acc-1")).toEqual({ username: "u", token: "t" });
		});

		it("principalPath без ведущего слэша: поле отброшено, credential валиден", () => {
			const raw = JSON.stringify({ username: "u", token: "t", principalPath: "no-slash" });
			expect(portWith(raw).get("acc-1")).toEqual({ username: "u", token: "t" });
		});
	});

	it("не кэширует: изменение значения в хранилище видно следующему get()", () => {
		const storage = makeStorage({
			"acc-1": JSON.stringify({ username: "old", token: "t1" }),
		});
		const port = new SecretStorageCredentials(storage, () => [account()]);

		expect(port.get("acc-1")?.username).toBe("old");

		storage.setSecret("acc-1", JSON.stringify({ username: "new", token: "t2" }));

		expect(port.get("acc-1")?.username).toBe("new");
	});
});

describe("secretStorageOf", () => {
	it("возвращает secretStorage, если на нём есть все три метода контракта", () => {
		const storage = makeStorage();
		expect(secretStorageOf({ secretStorage: storage })).toBe(storage);
	});

	it("{} -> null", () => {
		expect(secretStorageOf({})).toBeNull();
	});

	it("null/undefined app -> null", () => {
		expect(secretStorageOf(null)).toBeNull();
		expect(secretStorageOf(undefined)).toBeNull();
	});

	it("secretStorage без части методов -> null", () => {
		expect(secretStorageOf({ secretStorage: { setSecret: (): void => {} } })).toBeNull();
	});
});

describe("SecretStorageCredentials.setPayload", () => {
	it("раунд-трипится через get()", () => {
		const storage = makeStorage();
		const port = new SecretStorageCredentials(storage, () => [account()]);
		const payload = { username: "u", token: "t", principalPath: "/p/" };

		port.setPayload("acc-1", payload);

		expect(port.get("acc-1")).toEqual(payload);
	});

	it("невалидный secretRef -> throws invalid-secret-ref", () => {
		const port = new SecretStorageCredentials(makeStorage(), () => [account()]);
		expect(() => port.setPayload("UPPER", { username: "u", token: "t" })).toThrow(
			"invalid-secret-ref",
		);
	});

	it("хранилище недоступно -> throws secret-storage-unavailable", () => {
		const port = new SecretStorageCredentials(null, () => [account()]);
		expect(() => port.setPayload("acc-1", { username: "u", token: "t" })).toThrow(
			"secret-storage-unavailable",
		);
	});
});

describe("SecretStorageCredentials.clearPayload", () => {
	// §4.1 заказа: delete-метода в Obsidian 1.11.4 нет (см. obsidian.d.ts),
	// поэтому «удаление» — задокументированное отступление: перезапись пустой
	// строкой. id аккаунта остаётся в listSecrets() навсегда.
	it("перезаписывает пустой строкой; get() после этого null; id остаётся в listSecrets", () => {
		const storage = makeStorage({ "acc-1": JSON.stringify({ username: "u", token: "t" }) });
		const port = new SecretStorageCredentials(storage, () => [account()]);

		port.clearPayload("acc-1");

		expect(port.get("acc-1")).toBeNull();
		expect(storage.listSecrets()).toContain("acc-1");
	});

	it("невалидный secretRef -> throws invalid-secret-ref", () => {
		const port = new SecretStorageCredentials(makeStorage(), () => [account()]);
		expect(() => port.clearPayload("")).toThrow("invalid-secret-ref");
	});

	it("хранилище недоступно -> throws secret-storage-unavailable", () => {
		const port = new SecretStorageCredentials(null, () => [account()]);
		expect(() => port.clearPayload("acc-1")).toThrow("secret-storage-unavailable");
	});
});
