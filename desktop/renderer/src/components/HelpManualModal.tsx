import React, { useState } from "react";
import type { Lang } from "../i18n.js";

/**
 * 使用手册 / User Guide —— 账号菜单入口打开的大弹窗。
 * 左侧模块导航 + 右侧图文讲解，中英双语（英文为主）。
 * 内容全部基于客户端真实功能（右键菜单/总目标/脑网络/数字婴儿/会员…），不虚构。
 * 插图用内联简约 SVG（线性 · currentColor · 无为 VI），无外部资源；
 * 需要真实截图处用 <figure class="guide-shot"> 占位，后续可直接替换成 <img>。
 */

type Props = { lang: Lang; onClose: () => void };

// 双语小工具：英文为主。
function useL(lang: Lang) {
  return (en: string, zh: string) => (lang === "en" ? en : zh);
}

// —— 章节图标（统一 18px 线性 currentColor）——
const IconStart = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" /></svg>
);
const IconModes = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="8" r="2.5" /><path d="M11 8h9" /><circle cx="17" cy="16" r="2.5" /><path d="M13 16H4" /></svg>
);
const IconSessions = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9h17M8 13h8M8 16h5" /></svg>
);
const IconGoal = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4.4" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>
);
const IconBrain = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.4A3 3 0 0 0 7 18.5a2.5 2.5 0 0 0 2.5 1V4.5z" /><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.4A3 3 0 0 1 17 18.5a2.5 2.5 0 0 1-2.5 1V4.5z" /></svg>
);
const IconPalace = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M4 21V9.5l8-5 8 5V21" /><path d="M9 21v-6h6v6M9.5 11.5h.01M14.5 11.5h.01" /></svg>
);
const IconCoins = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6.5" rx="7" ry="3" /><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /></svg>
);
const IconHelp = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-11.7 7.9L4 20l1.4-4A8.5 8.5 0 1 1 21 11.5z" /><path d="M12 8.5v.01M12 11v3.5" /></svg>
);
const IconSettings = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14 2h-4l-.3 2.1a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.3l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3L10 22h4l.3-2.1a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z" /></svg>
);

// —— 内容小组件 ——
function Tip({ children, tone = "accent" }: { children: React.ReactNode; tone?: "accent" | "pro" }) {
  return <div className={"guide-tip guide-tip--" + tone}>{children}</div>;
}
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="guide-kbd">{children}</kbd>;
}
// 简约「截图/示意」框：内含内联 SVG 演示，需要时可整块换成 <img src=…>
function Shot({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="guide-shot">
      <div className="guide-shot__frame">{children}</div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
function FeatRow({ badge, title, desc }: { badge: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="guide-feat">
      <div className="guide-feat__badge">{badge}</div>
      <div className="guide-feat__body">
        <div className="guide-feat__title">{title}</div>
        <div className="guide-feat__desc">{desc}</div>
      </div>
    </div>
  );
}

export function HelpManualModal({ lang, onClose }: Props) {
  const L = useL(lang);
  const [active, setActive] = useState("start");

  const sections: { id: string; icon: React.ReactNode; label: string; body: React.ReactNode }[] = [
    {
      id: "start",
      icon: IconStart,
      label: L("Getting started", "快速上手"),
      body: (
        <>
          <p className="guide-lead">
            {L(
              "Wuwei is an AI agent that doesn't just chat — it reads your files, runs commands, searches the web, and carries out real multi-step tasks. This guide takes you from zero to power user.",
              "无为不只是聊天，它是一个能读文件、跑命令、联网搜索、真正一步步替你干活的 AI 智能体。这份手册带你从零变成高手。",
            )}
          </p>
          <h4>{L("First 3 steps", "开头三步")}</h4>
          <FeatRow badge={<span className="guide-num">1</span>} title={L("Sign in", "登录")} desc={L("Click your avatar at the bottom-left to sign in — you get free hosted quota to try any model right away.", "点左下角头像登录，登录即送托管额度，任意模型都能马上试。")} />
          <FeatRow badge={<span className="guide-num">2</span>} title={L("Pick a model", "选模型")} desc={L("Use the model picker in the input bar. Hosted models (Claude / GPT / Gemini / GLM …) work out of the box. You can also plug in your own Claude subscription or API key.", "在输入栏下方选模型。托管模型（Claude / GPT / Gemini / GLM…）开箱即用；也可接你自己的 Claude 订阅或 API Key。")} />
          <FeatRow badge={<span className="guide-num">3</span>} title={L("Describe the task", "描述任务")} desc={L("Type what you want — plain language. You can paste images too. Then let it run.", "用大白话说你想要什么，也能直接粘贴图片，然后让它跑。")} />
          <Tip>
            {L("Not sure what to ask? Try: “Look through this folder and tell me what this project does”, or paste a screenshot of an error and ask it to fix it.", "不知道问啥？试试：「看下这个文件夹，告诉我这个项目是干嘛的」，或者粘贴一张报错截图让它修。")}
          </Tip>
        </>
      ),
    },
    {
      id: "modes",
      icon: IconModes,
      label: L("Run modes & depth", "运行模式与深度"),
      body: (
        <>
          <p className="guide-lead">{L("Three run modes decide how much freedom the agent has. Switch them per-conversation in the input bar.", "输入栏里的三个运行模式决定放多少权给智能体，每个会话各记各的。")}</p>
          <FeatRow badge={<span className="guide-chip">{L("Manual", "手动")}</span>} title={L("Approve each step", "每步确认")} desc={L("It asks permission before every tool call or command. Maximum control — good for sensitive work.", "每次调工具/跑命令前都问你。掌控最强，适合敏感操作。")} />
          <FeatRow badge={<span className="guide-chip">{L("Auto", "自动")}</span>} title={L("Auto-approve", "自动放行")} desc={L("Permissions auto-granted so it runs the whole task without stopping to ask.", "自动放行权限，一口气把任务跑完，不再逐步打断你。")} />
          <FeatRow badge={<span className="guide-chip guide-chip--on">{L("Smart-continue", "智能继续")}</span>} title={L("Runs, then keeps going", "跑完还自己接着推进")} desc={L("Auto-approves AND, after finishing a round, works out the next step and continues on its own — great for long autonomous work (even overnight).", "自动放行 + 跑完一轮后自己算出下一步接着推进，适合长时间自主干活（半夜也能跑）。")} />
          <h4>{L("Thinking depth", "思考档位")}</h4>
          <p>{L("The depth picker trades speed for rigor:", "档位在快和深之间取舍：")}</p>
          <div className="guide-scale">
            <span>{L("Fast", "快")}</span>
            <span className="guide-scale__on">{L("Balanced ·rec.", "平衡·推荐")}</span>
            <span>{L("Deep", "深入")}</span>
            <span>{L("Deeper", "很深")}</span>
            <span>{L("Max", "极致")}</span>
          </div>
          <Tip>{L("Keep Balanced for most work. Bump to Deep / Max only for hard refactors or tricky debugging — they're slower and can time out.", "多数活儿用「平衡」就够。只有硬骨头（大重构、疑难排查）才上「深入/极致」，它们更慢、也更容易超时。")}</Tip>
        </>
      ),
    },
    {
      id: "sessions",
      icon: IconSessions,
      label: L("Sessions & hidden tricks", "会话与隐藏秘技"),
      body: (
        <>
          <p className="guide-lead">{L("The real power is in the right-click menu. Right-click any conversation in the left list to reveal it.", "真正的威力藏在右键菜单里。在左侧列表右键任意一个对话就能打开。")}</p>
          <figure className="guide-shot">
            <div className="gm-stage">
              <div className="gm-menu">
                <div className="gm-item"><IconHandoff /><span>{L("Summarize and hand off to a new chat", "总结并交接到新对话")}</span></div>
                <div className="gm-sep" />
                <div className="gm-item"><IconGoal2 /><span>{L("Set overall goal…", "设置总目标…")}</span></div>
                <div className="gm-item"><IconHist /><span>{L("View full history…", "查看完整历史…")}</span></div>
                <div className="gm-sep" />
                <div className="gm-item gm-done"><IconCheck /><span>{L("Mark done", "标记完成")}</span></div>
                <div className="gm-item"><IconDiscuss /><span>{L("Mark to discuss", "标记待讨论")}</span></div>
                <div className="gm-sep" />
                <div className="gm-head">{L("Move to group", "移动到分组")}</div>
                <div className="gm-item"><IconPlusSm /><span>{L("New group…", "新建分组…")}</span></div>
                <div className="gm-sep" />
                <div className="gm-head">{L("Priority", "优先级")}</div>
                <div className="gm-chips">
                  <span className="gm-chip gm-chip--on">{L("None", "无")}</span>
                  <span className="gm-chip">{L("High", "高")}</span>
                  <span className="gm-chip">{L("Medium", "中")}</span>
                  <span className="gm-chip">{L("Low", "低")}</span>
                </div>
                <div className="gm-head">{L("Quadrants (importance/urgency)", "四象限（重要/紧急）")}</div>
                <div className="gm-quad">
                  <span className="gm-qb">{L("Urgent & important", "紧急重要")}</span>
                  <span className="gm-qb">{L("Important, not urgent", "不紧急重要")}</span>
                  <span className="gm-qb">{L("Urgent, not important", "紧急不重要")}</span>
                  <span className="gm-qb">{L("Neither", "不紧急不重要")}</span>
                </div>
              </div>
            </div>
            <figcaption>{L("The actual right-click menu, reproduced item by item", "真实的右键菜单，逐项 1:1 还原")}</figcaption>
          </figure>
          <FeatRow badge={<IconGoal2 />} title={L("Summarize & hand off to a new chat", "总结并交接到新对话")} desc={L("Distills what matters from a long, messy chat and opens a clean new one to continue — beats a polluted context. If the chat has an overall goal, it carries over and auto-resumes.", "把又长又乱的对话里有价值的东西提炼出来，开一个干净的新对话接着做，解决上下文被污染。若原对话设了总目标，会一并带过去并自动续跑。")} />
          <FeatRow badge={<IconGoal2 />} title={L("Set overall goal", "设置总目标")} desc={L("Give the chat one big goal; it self-decomposes and drives step by step until done. Pair with Smart-continue for hands-off progress.", "给对话定一个大目标，它自己拆解、一步步推进，做完为止。配「智能继续」即可放手让它跑。")} />
          <FeatRow badge={<IconHist />} title={L("View full history", "查看完整历史")} desc={L("See the original exchanges from before context compaction — nothing is lost even after long autonomous runs.", "查看上下文压缩之前的原始交流，跑再久也能回看，什么都不丢。")} />
          <FeatRow badge={<IconCheck />} title={L("Mark done / for discussion", "标记完成 / 待讨论")} desc={L("Flag a conversation as finished, or as something to revisit. Keeps a long list organized.", "把对话标成已完成，或标成待回头讨论，长列表也井井有条。")} />
          <FeatRow badge={<IconPrio />} title={L("Priority & Eisenhower quadrants", "优先级与四象限")} desc={L("Tag High / Medium / Low, or use the Important×Urgent quadrants. Tagged chats sort to the top.", "打 高/中/低，或用「重要×紧急」四象限。打过标的对话会排到前面。")} />
          <FeatRow badge={<IconGroup />} title={L("Groups", "分组")} desc={L("Move conversations into custom groups, or create a new group on the fly.", "把对话移进自定义分组，也能随手新建分组。")} />
          <Tip>
            {L("Search everything with ", "全局搜索用 ")}<Kbd>{L("Ctrl / ⌘ + F", "Ctrl / ⌘ + F")}</Kbd>{L(" — it searches inside all conversation content, not just titles. Drag the sidebar edge to widen it; click « to collapse.", " —— 它搜的是所有对话的正文内容，不只是标题。拖侧栏右缘可加宽，点 « 收起。")}
          </Tip>
        </>
      ),
    },
    {
      id: "goals",
      icon: IconGoal,
      label: L("Goals & autonomy", "总目标与自主推进"),
      body: (
        <>
          <p className="guide-lead">{L("This is what makes Wuwei an agent, not a chatbot: set a goal, walk away, come back to results.", "这正是无为区别于聊天机器人的地方：设个目标、走开、回来看结果。")}</p>
          <div className="guide-flow">
            <div className="guide-flow__step"><span>1</span>{L("Right-click a chat → Set overall goal", "右键对话 → 设置总目标")}</div>
            <div className="guide-flow__arrow">→</div>
            <div className="guide-flow__step"><span>2</span>{L("Turn on Smart-continue", "打开智能继续")}</div>
            <div className="guide-flow__arrow">→</div>
            <div className="guide-flow__step"><span>3</span>{L("It self-decomposes & runs to completion", "它自拆解、自推进到完成")}</div>
          </div>
          <p>{L("Under the hood it plans the goal into steps, executes each, checks its own progress, and keeps going until the goal is met — approving its own routine permissions along the way.", "内部它会把目标拆成若干步，逐步执行、自查进度，一路自动放行常规权限，直到达成目标为止。")}</p>
          <Tip>{L("When a long run has bloated the context, use “Summarize & hand off” — it carries the goal into a fresh chat and resumes automatically, so momentum isn't lost.", "跑久了上下文变臃肿时，用「总结并交接」——它会把目标带进一个干净的新对话并自动续跑，势头不断。")}</Tip>
        </>
      ),
    },
    {
      id: "brain",
      icon: IconBrain,
      label: L("Brain Network", "脑网络"),
      body: (
        <>
          <div className="guide-protag">Pro</div>
          <p className="guide-lead">{L("The Brain Network is Wuwei's long-term memory. It quietly distills valuable concepts and experience from your chats, so you never have to re-explain your preferences and projects.", "脑网络是无为的长期记忆。它悄悄把对话里有价值的概念与经验沉淀下来，你不必反复交代自己的偏好和项目。")}</p>
          <Shot caption={L("Two views: the concept graph, and the knowledge pyramid", "两种视图：概念网络图 · 知识金字塔")}>
            <svg viewBox="0 0 320 150" width="100%" fill="none" stroke="currentColor">
              <g strokeWidth="1.3" opacity="0.7">
                <circle cx="70" cy="75" r="10" /><circle cx="40" cy="40" r="6" /><circle cx="42" cy="112" r="7" /><circle cx="105" cy="48" r="6" /><circle cx="110" cy="108" r="7" />
                <path d="M70 75l-27-33M70 75l-26 35M70 75l33-25M70 75l38 31" strokeOpacity="0.5" />
              </g>
              <g strokeWidth="1.3" opacity="0.85" transform="translate(190 20)">
                <path d="M60 0l55 95H5z" strokeOpacity="0.5" />
                <path d="M22 60h76M38 90h44" strokeOpacity="0.5" />
                <circle cx="60" cy="26" r="3" fill="currentColor" />
              </g>
            </svg>
          </Shot>
          <FeatRow badge={<IconBrain2 />} title={L("Learns continuously", "持续学习")} desc={L("Turns meaningful moments in conversation into durable memory — automatically.", "把对话里有意义的片段自动变成可长期保存的记忆。")} />
          <FeatRow badge={<IconBrain2 />} title={L("Recalls across chats", "跨对话回忆")} desc={L("Next time it pulls in your past experience and preferences without you repeating them.", "下次自动调用你过去的经验与偏好，不用你再说一遍。")} />
          <FeatRow badge={<IconBrain2 />} title={L("Gets richer with use", "越用越丰富")} desc={L("Memory isn't capped by a single conversation's length — the more you use it, the more it understands you.", "记忆不受单次对话长度限制，用得越久越懂你。")} />
          <Tip tone="pro">{L("Brain Network is a Pro feature. Open it from the left panel; free users see an intro. Background learning progress shows in the status bar at the bottom.", "脑网络是 Pro 功能。从左侧面板进入，免费用户会看到介绍页。后台学习进度在底部状态栏实时显示。")}</Tip>
        </>
      ),
    },
    {
      id: "palace",
      icon: IconPalace,
      label: L("Knowledge Palace", "知识宫殿"),
      body: (
        <>
          <div className="guide-protag">Pro</div>
          <p className="guide-lead">{L("Point Wuwei at a folder of your own documents — notes, an Obsidian vault, specs, past write-ups — and it becomes a searchable Knowledge Palace. The AI pulls the exact relevant passages on demand instead of you pasting everything in.", "把无为指向一个你自己的文档文件夹——笔记、Obsidian 库、规范、过往文稿——它就变成一座可检索的「知识宫殿」。需要时 AI 只捞出真正相关的段落，你不用再把一堆东西整段贴进去。")}</p>
          <h4>{L("Set it up", "怎么建")}</h4>
          <div className="guide-flow">
            <div className="guide-flow__step"><span>1</span>{L("Settings → Brain Network → Document library", "设置 → 脑网络 → 文档库")}</div>
            <div className="guide-flow__arrow">→</div>
            <div className="guide-flow__step"><span>2</span>{L("Browse to your folder, click Build index", "选到你的文件夹，点建索引")}</div>
            <div className="guide-flow__arrow">→</div>
            <div className="guide-flow__step"><span>3</span>{L("Rebuild whenever the docs change", "文档有变就重建一次")}</div>
          </div>
          <FeatRow badge={<IconPalace2 />} title={L("Indexing (scan + vectorize)", "建索引（扫描 + 向量化）")} desc={L("It scans every document and builds a semantic index. Big libraries take a moment the first time; after that it's instant.", "它扫描每个文档、建立语义索引。第一次库大会花点时间，之后就是秒回。")} />
          <FeatRow badge={<IconPalace2 />} title={L("Concept extraction (optional)", "概念抽取（可选）")} desc={L("Pull concepts and relations out of the indexed docs into the Brain graph — so your knowledge shows up as a connected map, not just loose text. Runs per-document to save tokens, and can be stopped anytime.", "从已索引文档里抽出概念和关系，填进脑网络图谱——你的知识就成了一张连起来的图，而不只是散落的文本。按文档逐个跑、省 token，随时可停。")} />
          <FeatRow badge={<IconPalace2 />} title={L("Scan related docs on recall", "检索时扫描相关文档")} desc={L("Keep this sub-toggle on: when the AI recalls memory, it also returns the most relevant original fragments from your Palace — with their file paths.", "保持这个子开关开着：AI 检索记忆时，会连带返回宫殿里最相关的原文片段——并附上文件路径。")} />
          <Tip tone="pro">{L("At work time it stays lean: recall returns a summary + path, and the AI reads the full document only when it actually needs it (via brain_read_doc). Your whole knowledge base is available without burning tokens on what isn't relevant.", "干活时很省：检索只给「摘要 + 路径」，AI 真正需要时才去读整篇原文（brain_read_doc）。整座知识库随取随用，又不会为无关内容白烧 token。")}</Tip>
        </>
      ),
    },
    {
      id: "coins",
      icon: IconCoins,
      label: L("Coins & membership", "无为币与会员"),
      body: (
        <>
          <p className="guide-lead">{L("Hosted models run on coins. You get coins from membership, daily check-in, and top-ups.", "托管模型消耗无为币。币来自会员、每日签到、充值三处。")}</p>
          <FeatRow badge={<IconCheck />} title={L("Daily check-in", "每日签到")} desc={L("Open the account panel and check in every day for free coins — higher tiers earn more per day.", "在账号面板每天签到领币，等级越高每日领得越多。")} />
          <div className="guide-plans">
            <div className="guide-plan"><b>Pro</b><span>¥29 · $6.99/mo</span><em>{L("Monthly quota · 20/day check-in", "包月额度 · 签到 20/日")}</em></div>
            <div className="guide-plan guide-plan--rec"><b>Plus</b><span>¥99 · $19.99/mo</span><em>{L("5× quota · 40/day", "5× 额度 · 签到 40/日")}</em></div>
            <div className="guide-plan"><b>Max</b><span>¥899 · $199/mo</span><em>{L("50× quota · 100/day", "50× 额度 · 签到 100/日")}</em></div>
          </div>
          <Tip>{L("Membership also unlocks the Brain Network and every hosted model (Claude / GPT / Gemini / GLM …). Running low mid-task pops a top-up so you're never blocked.", "会员还解锁脑网络和全部托管模型（Claude / GPT / Gemini / GLM…）。任务途中缺币会弹充值，不会把你卡死。")}</Tip>
        </>
      ),
    },
    {
      id: "help",
      icon: IconHelp,
      label: L("Messages · Support · Feedback", "消息 · 客服 · 反馈"),
      body: (
        <>
          <p className="guide-lead">{L("Everything lives in the account menu (click your avatar, bottom-left).", "这些都在账号菜单里（点左下角头像）。")}</p>
          <FeatRow badge={<IconBell />} title={L("Message Center", "消息中心")} desc={L("Rewards, activities, system notices and replies to your feedback — a red badge shows unread count.", "奖励到账、活动、系统通知、反馈回复都在这，未读会亮红点数字。")} />
          <FeatRow badge={<IconHelp2 />} title={L("Contact support", "联系客服")} desc={L("Opens a live chat window — send and receive in real time. Or scan the WeChat QR to add support.", "打开在线对话窗，实时收发；也可扫微信二维码加客服。")} />
          <FeatRow badge={<IconChat />} title={L("Feedback for rewards", "反馈有奖")} desc={L("Leave a suggestion or bug report. If it's adopted, we send you coins and membership as a thank-you.", "留个建议或报个 bug。被采纳的话，我们送你无为币和会员作为感谢。")} />
          <Tip>{L("Adopted feedback really does get rewarded and you'll get an email plus a Message Center notice when it lands.", "被采纳的反馈是真发奖的，到账时你会收到邮件和消息中心通知。")}</Tip>
        </>
      ),
    },
    {
      id: "settings",
      icon: IconSettings,
      label: L("Settings walkthrough", "设置逐栏详解"),
      body: (
        <>
          <p className="guide-lead">{L("Open Settings from the account menu. The left menu has ten tabs — here's what each one is for.", "从账号菜单打开设置。左侧有十个分栏，这里逐个说清用途。")}</p>

          <h4>{L("General", "通用")}</h4>
          <FeatRow badge={<IconSettings2 />} title={L("Language", "语言")} desc={L("Switch the whole app between English and 中文 anytime.", "随时在英文和中文之间切换整个界面。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Session grouping", "会话分组")} desc={L("Manual (drag & right-click into groups), by-date, or by-project (AI auto-buckets chats by their content).", "手动（拖拽 / 右键归组）、按日期、或按项目（AI 按对话内容自动归类）。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Context compaction", "上下文压缩")} desc={L("When a chat gets long, older messages are summarized to fit the model's window. Set how many recent messages to keep verbatim, plus the token threshold and message-count threshold that trigger it (either one fires it; blank token = auto 80% of the model's context).", "对话变长时，较旧消息被摘要以塞进模型窗口。可设保留多少条最近原文，外加触发压缩的 Token 阈值和消息条数阈值（任一命中即压；Token 留空=自动取模型上下文 80%）。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Full history archive", "完整历史归档")} desc={L("Pre-compaction originals are archived (right-click a chat → View full history). Set retention days; 0 = keep forever.", "压缩前的原文会归档（右键会话 → 查看完整历史）。可设保留天数；填 0 = 永久保留。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Thinking-depth picker", "思考档位选择器")} desc={L("Toggle the Fast / Balanced / Deep selector under the input bar. Lower a notch if tasks keep timing out mid-run.", "开关输入框下方的「快/平衡/深入」档位选择器。任务老在半路超时就调低一档。")} />

          <h4>{L("Appearance", "外观")}</h4>
          <FeatRow badge={<IconSettings2 />} title={L("Output style", "输出方式")} desc={L("Choose how replies appear: Stream (shown in batches as they arrive), Typewriter (steady char-by-char, smoothest), or All-at-once (nothing shows until the reply is fully done).", "选回复怎么呈现：流式（收到即整批显示）、打字机（匀速逐字，最丝滑）、回完一次性（回复期间不显示，完成后一次性给出）。")} />

          <h4>{L("Model & Platforms", "模型与平台")}</h4>
          <FeatRow badge={<IconSettings2 />} title={L("Model", "模型")} desc={L("Pick the active provider & model, and enter your own API key / base URL / subscription token and thinking depth if you use your own account.", "选当前用哪个供应商和模型；用自己账号时在这填 API Key / Base URL / 订阅令牌和思考档位。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Platform management", "平台管理")} desc={L("Reorder, edit, delete or hide any provider (the eye icon). Add a custom provider or relay. Hidden ones only disappear from the bottom “switch platform” menu — they stay usable here.", "拖动排序、编辑、删除或隐藏任意供应商（眼睛图标），也能添加自定义供应商/中转站。隐藏只影响底部「切换平台」菜单，此处仍可用。")} />

          <h4>{L("Personalization", "个性化")}</h4>
          <FeatRow badge={<IconSettings2 />} title={L("System prompt — you're in full control", "系统提示词 —— 完全由你掌控")} desc={L("A global instruction that shapes how the AI behaves in every chat — its tone, rules, what to always do or avoid. Tools like Claude Code and Codex ship a built-in system prompt of tens of thousands of tokens, so even a plain “hello” burns that much before you've started. In Wuwei it's fully yours to edit — you decide exactly what the AI is told, and keep it as lean as you want.", "一段全局指令，塑造 AI 在每个对话里的风格、规则、该做/该避免什么。像 Claude Code、Codex 这类工具，内置系统提示词动辄几万 token——你只发一句「哈喽」，一开口就先烧掉几万 token。无为这里完全交给你自定义：AI 被告知什么、留多精简，全由你说了算，真正完全掌控 AI。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Memory", "记忆")} desc={L("Facts you want it to always know (your stack, names, preferences). Simpler than the Brain Network — it's a plain always-on note you edit by hand.", "你想让它始终记得的事实（技术栈、名字、偏好）。比脑网络简单，就是一段手动编辑、始终生效的备忘。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Brain Network (Pro)", "脑网络（Pro）")} desc={L("The auto-learning long-term memory — graph & pyramid views plus its learning prompt. See the Brain Network section for details.", "自动学习的长期记忆——网络图/金字塔视图 + 学习提示词。详见「脑网络」一节。")} />

          <h4>{L("Power tools", "进阶能力")}</h4>
          <FeatRow badge={<IconSettings2 />} title={L("MCP", "MCP")} desc={L("Connect MCP servers to extend what the agent can do (files, knowledge-graph memory, and more). Install from the built-in catalog in one click, or add your own.", "接入 MCP 服务器扩展智能体能力（文件、知识图谱记忆等）。可从内置目录一键安装，也能自定义添加。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Tools", "工具")} desc={L("Turn built-in tools on/off (web search, running commands, file edits …) and search the full list.", "开关内置工具（联网搜索、执行命令、改文件…），可搜索整个列表。")} />
          <FeatRow badge={<IconSettings2 />} title={L("Secrets / Keys", "密钥")} desc={L("A local secret manager. It can detect a new key before you send and, once stored, auto-replaces secrets with placeholders so they never reach the AI in plain text.", "本地密钥管理器。发送前可检测疑似新密钥；入库后会自动用占位符替换敏感信息，绝不明文发给 AI。")} />

          <Tip>{L("On a Claude subscription the usable context is capped lower than the API's 1M — so compaction may kick in earlier than the “/1M” display suggests. For the largest context, use an API key.", "用 Claude 订阅时，可用上下文比 API 的 1M 低（有封顶），所以压缩可能比「/1M」显示的更早触发。要最大上下文请用 API Key。")}</Tip>
        </>
      ),
    },
  ];

  const cur = sections.find((s) => s.id === active) || sections[0];

  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide-modal" onClick={(e) => e.stopPropagation()}>
        {/* 左：导航 */}
        <aside className="guide-nav">
          <div className="guide-nav__brand">
            <div className="guide-nav__brandttl">{L("User Guide", "使用手册")}</div>
            <div className="guide-nav__brandsub">{L("Master Wuwei from zero", "从零把无为玩透")}</div>
          </div>
          <nav className="guide-nav__list">
            {sections.map((s) => (
              <button key={s.id} className={"guide-nav__it" + (s.id === active ? " on" : "")} onClick={() => setActive(s.id)}>
                <span className="guide-nav__ico">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        {/* 右：内容 */}
        <section className="guide-body">
          <header className="guide-body__head">
            <span className="guide-body__ico">{cur.icon}</span>
            <h3>{cur.label}</h3>
            <button className="guide-x" onClick={onClose} aria-label={L("Close", "关闭")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          <div className="guide-body__scroll">{cur.body}</div>
        </section>
      </div>
    </div>
  );
}

// —— 内容里复用的小图标（16px 线性）——
function IconGoal2() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" /></svg>; }
function IconHandoff() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7l-4 4 4 4" /><path d="M5 11h9a5 5 0 0 1 5 5v1" /></svg>; }
function IconDiscuss() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 15.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /></svg>; }
function IconPlusSm() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>; }
function IconHist() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v11.5a1.5 1.5 0 0 1-1.5 1.5H7a3 3 0 0 1-3-3V5.5z" /><path d="M8 8.5h8M8 12h8M8 15.5h5" /></svg>; }
function IconCheck() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12.5l5 5 11-11" /></svg>; }
function IconPrio() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 21V4M5 4l11 3-4 4 4 4-11 3" /></svg>; }
function IconGroup() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h7l2 2h9v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z" /></svg>; }
function IconBrain2() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2.4" /><path d="M12 5v4M12 15v4M5 12h4M15 12h4M7 7l2.4 2.4M14.6 14.6L17 17M17 7l-2.4 2.4M9.4 14.6L7 17" /></svg>; }
function IconPalace2() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M4 21V9.5l8-5 8 5V21" /><path d="M9 21v-6h6v6" /></svg>; }
function IconBell() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>; }
function IconHelp2() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13v-1a8 8 0 0 1 16 0v1" /><rect x="3" y="13" width="4" height="6" rx="1.5" /><rect x="17" y="13" width="4" height="6" rx="1.5" /><path d="M20 19a4 4 0 0 1-4 4h-2" /></svg>; }
function IconChat() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-11.7 7.9L4 20l1.4-4A8.5 8.5 0 1 1 21 11.5z" /></svg>; }
function IconSettings2() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18" /></svg>; }
