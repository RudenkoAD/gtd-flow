declare module "electron" {
	export const shell:
		| {
				openExternal(target: string): Promise<void>;
		  }
		| undefined;
}
