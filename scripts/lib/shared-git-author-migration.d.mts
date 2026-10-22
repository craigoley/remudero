export interface MigrationPlan {schema:string;pool:string;configSha256:string;inventorySha256:string;worktreeCount:number;mainBarePreserved:true;liveApplicationAuthorized:false;planSha256:string}
export function inspectSharedGitAuthorMigration(pool:string):MigrationPlan;
export function applySharedGitAuthorMigration(pool:string,expectedPlanSha256:string,options?:{confirmIdle?:boolean;borrowWorker?:()=>Promise<{admitted:boolean;verify?:()=>void}>}):Promise<{state:string;reason?:string;backup:string;plan:MigrationPlan;configSha256?:string;modelCalls:0;automaticRollback:false}>;
