export type GuicosResourceType<TResource> = new (...args: any[]) => TResource;

export interface IGuicosResourceManager {
    load<TResource>(path: string, type: GuicosResourceType<TResource>): Promise<TResource>;
}
