import type { AdmissionComponent } from "./plan-admission-graph";

/** Freeze remote identity/absence authority for structural endpoint re-observation. */
export function componentRemoteIdentities(component: AdmissionComponent): Record<string, string | null> {
	const identities: Record<string, string | null> = {};
	for (const action of component.actions) {
		if (action.remote?.identityKey) identities[action.path] = action.remote.identityKey;
		if (action.baseline?.remoteIdentityKey) identities[action.baseline.path] = action.baseline.remoteIdentityKey;
	}
	for (const evidence of component.evidence) {
		if (evidence.kind === "rename" && evidence.side === "remote" && evidence.identityKey) {
			identities[evidence.oldPath] = evidence.identityKey;
			identities[evidence.newPath] = evidence.identityKey;
		} else if (evidence.kind === "stable_identity") {
			for (const occurrence of evidence.occurrences) {
				if (occurrence.side === "remote") {
					identities[occurrence.path] = occurrence.identityKey ?? evidence.identityKey;
				}
			}
		}
	}
	for (const observation of component.observations) {
		if (observation.side !== "remote") continue;
		if (observation.kind === "absent") identities[observation.requestedPath] = null;
		else if ((observation.kind === "exact" || observation.kind === "alias") &&
			observation.entity.identityKey) {
			identities[observation.requestedPath] = observation.entity.identityKey;
			if (observation.kind === "alias") identities[observation.resolvedPath] = observation.entity.identityKey;
		}
	}
	return identities;
}

export function remoteIdentityAuthority(identities: Readonly<Record<string, string | null>>): string {
	return JSON.stringify(Object.entries(identities).sort());
}
