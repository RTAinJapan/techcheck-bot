// bot の AWS のキーに、要る権限が付いているかを、起動のときに確かめる。
//
// IAM のポリシーのシミュレーション (iam:SimulatePrincipalPolicy) で、「この操作を、このフローに対して行えるか」を AWS に聞く。
// 実際には何も実行しない (フローを開始・停止せずに、StartFlow / StopFlow の権限も確かめられる)。
// フローを読む (DescribeFlow) だけの確認では、開始・停止の権限が欠けていても、配信者がテストを始めるまで気づけない。
//
// - bot の IAM ユーザーに、自分自身に対する iam:SimulatePrincipalPolicy が要る (docs/createToken.md のポリシー)。
//   無ければ、確かめられなかったと伝えるだけで、起動は続ける。
// - 確かめる操作は、src/adapters/aws.ts が送るコマンドと同じ。足したり減らしたりしたら、ここも直す。

import { IAMClient, SimulatePrincipalPolicyCommand, type EvaluationResult } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/** フローの ARN で絞れる操作 */
export const kFlowActions = [
    "mediaconnect:DescribeFlow",
    "mediaconnect:StartFlow",
    "mediaconnect:StopFlow",
    "mediaconnect:DescribeFlowSourceMetadata",
    "mediaconnect:DescribeFlowSourceThumbnail",
];
/** リソースで絞れない操作 */
export const kGlobalActions = ["cloudwatch:GetMetricData"];

export interface DeniedAction {
    action: string;
    /** フローの ARN。リソースで絞れない操作は "*" */
    resource: string;
    /** implicitDeny (許可が無い) / explicitDeny (明示的に拒否) */
    decision: string;
}

export interface PermissionCheck {
    /** 確かめられなかった理由。確かめられたときは無い */
    skipped?: string;
    /** 確かめた IAM ユーザーの名前 */
    user?: string;
    denied: DeniedAction[];
}

/** arn:aws:iam::123456789012:user/path/name → name。IAM ユーザーでなければ undefined */
export function iamUserName(arn: string | undefined): string | undefined {
    return /^arn:aws[\w-]*:iam::\d+:user\/(?:.*\/)?([^/]+)$/.exec(arn ?? "")?.[1];
}

/** シミュレーションの結果から、許可されていないものを拾う */
export function deniedFrom(results: Pick<EvaluationResult, "EvalActionName" | "EvalResourceName" | "EvalDecision">[]): DeniedAction[] {
    return results
        .filter((r) => r.EvalDecision !== "allowed")
        .map((r) => ({ action: r.EvalActionName ?? "?", resource: r.EvalResourceName ?? "*", decision: r.EvalDecision ?? "?" }));
}

export async function checkPermissions(region: string, credentials: { accessKeyId: string; secretAccessKey: string } | undefined, flowArns: string[]): Promise<PermissionCheck> {
    const who = await new STSClient({ region, credentials }).send(new GetCallerIdentityCommand({}));
    const user = iamUserName(who.Arn);
    if (!who.Arn || !user) {
        return { skipped: `IAM ユーザーのアクセスキーで動いていないので、シミュレーションでは確かめられません (${who.Arn ?? "?"})`, denied: [] };
    }
    const iam = new IAMClient({ region, credentials });
    const simulate = async (actions: string[], resources: string[]): Promise<DeniedAction[]> => {
        const denied: DeniedAction[] = [];
        let marker: string | undefined;
        do {
            const r = await iam.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: who.Arn, ActionNames: actions, ResourceArns: resources, Marker: marker }));
            denied.push(...deniedFrom(r.EvaluationResults ?? []));
            marker = r.IsTruncated ? r.Marker : undefined;
        } while (marker);
        return denied;
    };
    try {
        return { user, denied: [...(await simulate(kFlowActions, flowArns)), ...(await simulate(kGlobalActions, ["*"]))] };
    } catch (e) {
        const name = (e as Error).name;
        if (name === "AccessDenied" || name === "AccessDeniedException") {
            return {
                user,
                skipped: `IAM ユーザー ${user} に iam:SimulatePrincipalPolicy の権限がありません (docs/createToken.md のポリシーに足すと、起動のときに権限を確かめられます)`,
                denied: [],
            };
        }
        throw e;
    }
}

const kDecisionJa: Record<string, string> = { implicitDeny: "許可が無い", explicitDeny: "明示的に拒否されている" };

/** コンソールに出す行。flows は、ARN から名前を引くため */
export function permissionLines(check: PermissionCheck, flows: { name: string; arn: string }[]): string[] {
    if (check.skipped) return [`AWS: 権限の確認はしていません: ${check.skipped}`];
    if (check.denied.length === 0) return [`AWS: 権限: bot の使う操作は、すべて許可されています (IAM ユーザー ${check.user})`];
    // フローごと、理由ごとにまとめる
    const groups = new Map<string, string[]>();
    for (const d of check.denied) {
        const target = d.resource === "*" ? "" : `フロー ${flows.find((f) => f.arn === d.resource)?.name ?? d.resource} の `;
        const key = `${target}|${kDecisionJa[d.decision] ?? d.decision}`;
        groups.set(key, [...(groups.get(key) ?? []), d.action.replace(/^mediaconnect:/, "")]);
    }
    const lines = [...groups].map(([key, actions]) => {
        const [target, why] = key.split("|");
        return `AWS: 権限が足りません: ${target}${actions.join("、")} (${why})`;
    });
    return [...lines, `AWS: IAM ユーザー ${check.user} のポリシーを確かめてください (docs/createToken.md)。このままだと、テストは準備や計測で失敗します`];
}
