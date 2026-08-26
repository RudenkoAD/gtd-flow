/**
 * HTTP-порт CalDAV-клиента (§6.3 CalDAV-заказа). Чистый контракт: реализацию
 * (node:http(s) с ручными редиректами) подставляет desktop-адаптер, тесты —
 * скриптованные фейки. Порт умышленно узкий: метод, заголовки, тело, дедлайн.
 *
 * Инварианты реализации:
 * - редиректы НИКОГДА не следуются кросс-origin (запрос обрывается ошибкой,
 *   Authorization не уходит на чужой origin даже без заголовка);
 * - same-origin редиректы следуются ограниченно (см. адаптер);
 * - deadlineMs — жёсткий предел одного запроса; AbortSignal обрывает раньше.
 */
export interface CalDavHttpRequest {
	url: string;
	method: "GET" | "PROPFIND" | "REPORT";
	headers: Readonly<Record<string, string>>;
	body?: string;
	deadlineMs: number;
	signal?: AbortSignal;
}

export interface CalDavHttpResponse {
	status: number;
	/** Имена заголовков нормализованы к нижнему регистру. */
	headers: Readonly<Record<string, string>>;
	text: string;
}

export type CalDavHttpPort = (request: CalDavHttpRequest) => Promise<CalDavHttpResponse>;

/**
 * Порт учётных данных аккаунта. Резолвится в composition root (SecretStorage);
 * чистый протокольный код видит только этот интерфейс. Возврат null —
 * состояние credential_missing (никакого сетевого запроса).
 */
export interface CalDavCredential {
	/** Корпоративный логин (username для HTTP Basic). */
	username: string;
	/** OAuth-токен, используемый как пароль Basic (§6.3 заказа). */
	token: string;
	/** Кэш href выбранных коллекций: collectionKey → href (identity-bearing
	 *  данные живут ТОЛЬКО в SecretStorage-полезной нагрузке, §5.1/D8). */
	collections?: Record<string, string>;
	/** Fallback-путь principal (без origin), когда стандартное discovery
	 *  недоступно на сервере (§6.1.6); может содержать логин. */
	principalPath?: string;
}

export interface CalDavCredentialPort {
	get(accountId: string): CalDavCredential | null;
}
