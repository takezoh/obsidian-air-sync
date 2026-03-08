/** Authentication provider interface — abstracts OAuth/credential lifecycle */
export interface IAuthProvider {
	isAuthenticated(backendData: Record<string, unknown>): boolean;
	startAuth(backendData: Record<string, unknown>): Promise<Record<string, unknown>>;
	completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>>;
}
