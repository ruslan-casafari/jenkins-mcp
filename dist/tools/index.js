import { registerProjectTools } from "./projects.js";
import { registerBuildTools } from "./builds.js";
export function registerTools(server, client, config) {
    registerProjectTools(server, client, config);
    registerBuildTools(server, client, config);
}
