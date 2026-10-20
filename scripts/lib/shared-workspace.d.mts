export interface SharedGitPolicy { enabled:boolean; pool?:string; poolKind?:'existing-checkout'|'qualified-bare'; parent?:string; dependencyRoot?:string; dependencyDonor?:string; }
export function readSharedGitPolicy(home?:string):SharedGitPolicy;
export function readSharedWorkspaceCapacity(parent:string):{admitted:boolean;freeBytes:number;minimumFreeBytes:number;pressure:string};
export function borrowedWorkspaceWorker():Promise<{admitted:boolean;reason?:string;pid?:number;nonce?:string;start?:string}>;
export interface SharedWorkspaceResult {schema:string;state:string;reason?:string;modelCalls:0;freshNpmInstalls:0;automaticPruning:false;receiptDir?:string;path?:string;branch?:string;base?:string;commonGitDir?:string;dependencies?:{status:string;method?:string};}
export function createSharedWorkspace(taskId:string,options?:{home?:string;readCapacity?:(parent:string)=>{admitted:boolean};borrowWorker?:()=>Promise<{admitted:boolean}>;materialize?:(path:string,options:{root:string;sourceDir:string;runInstall:()=>never})=>Promise<{status:string}>;now?:()=>number}):Promise<SharedWorkspaceResult>;
