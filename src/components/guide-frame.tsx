import goToStepIcon from '@/assets/guide-go-to-step.webp'
import { useProgressStep } from '@/hooks/use_progress_step'
import { getGuideFromServer } from '@/ipc/guide_from_server'
import { copyPosition } from '@/lib/copy-position'
import { getGuideById } from '@/lib/guide'
import { cn } from '@/lib/utils'
import { useOpenGuideLink } from '@/mutations/open-guide-link.mutation'
import { useToggleGuideCheckbox } from '@/mutations/toggle-guide-checkbox.mutation'
import { confQuery } from '@/queries/conf.query'
import { guidesQuery } from '@/queries/guides.query'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import parse, { DOMNode, domToReact, type HTMLReactParserOptions } from 'html-react-parser'
import { ImageWithOrigin } from './image-with-origin'

export function GuideFrame({
  className,
  html,
  guideId,
  stepIndex,
}: {
  className?: string
  html: string
  guideId: number
  stepIndex: number
}) {
  const conf = useSuspenseQuery(confQuery)
  const toggleGuideCheckbox = useToggleGuideCheckbox()
  const step = useProgressStep(guideId, stepIndex)
  const openGuideLink = useOpenGuideLink()
  const guides = useSuspenseQuery(guidesQuery)
  const navigate = useNavigate()
  const getGuide = useMutation({
    mutationFn: async (guideId: number) => {
      const result = await getGuideFromServer(guideId)

      if (result.isErr()) throw result.error

      return result.value
    },
  })

  let checkboxesCount = 0

  const options: HTMLReactParserOptions = {
    replace: (domNode) => {
      const posReg = /(.*)\[(-?\d+),\s?(-?\d+)\](\w*)/

      // #region positions
      if (domNode.type === 'text') {
        const groups = posReg.exec(domNode.data)

        if (!groups) return

        const [, prefix, posX, posY, suffix] = groups

        return (
          <>
            {prefix}
            <button
              type="button"
              className="inline-flex font-semibold hover:saturate-50 focus:saturate-[12.5%]"
              onClick={async () => {
                await copyPosition(Number.parseInt(posX, 10), Number.parseInt(posY, 10), conf.data.autoTravelCopy)
              }}
            >
              [{posX},{posY}]
            </button>{' '}
            {suffix}
          </>
        )
      }
      // #endregion

      if (domNode.type === 'tag') {
        // #region empty p tags
        if (domNode.name === 'p' && domNode.children.length === 0) {
          const countEmptyP = (node: DOMNode | null): number => {
            if (!node) return 0

            if (node.type === 'tag' && node.name === 'p' && node.children.length === 0) {
              return 1 + countEmptyP(node.next as DOMNode | null)
            }

            return 0
          }

          const countNextEmptyP = countEmptyP(domNode)

          // disallow multiple empty p tags
          if (countNextEmptyP > 1) {
            return <></>
          }

          return <br />
        }
        // #endregion

        // #region guide step go to
        if (domNode.attribs['data-type'] === 'guide-step') {
          const stepNumber = Number.parseInt(domNode.attribs['stepnumber'] ?? 0)
          const domGuideId = Number.parseInt(domNode.attribs['guideid'] ?? 0)
          const hasGoToGuideIcon = domNode.children.some(
            (child) =>
              child.type === 'tag' &&
              child.name === 'img' &&
              child.attribs.src.includes('images/texteditor/guides.png'),
          )

          if (!Number.isNaN(domGuideId) || !Number.isNaN(stepNumber)) {
            const guide = guideId !== domGuideId ? getGuideById(guides.data.guides, domGuideId) : undefined

            return (
              <div className="contents hover:saturate-200 focus:saturate-[25%]">
                {/* same guide */}
                {guideId === domGuideId || domGuideId === 0 ? (
                  <Link
                    {...domNode.attribs}
                    to="/guides/$id"
                    params={{ id: domGuideId === 0 ? guideId : domGuideId }}
                    search={{ step: stepNumber - 1 }}
                    draggable={false}
                    className={cn('contents select-none data-[type=guide-step]:no-underline', domNode.attribs.class)}
                  >
                    {!hasGoToGuideIcon && (
                      <img src={goToStepIcon} className="size-5 select-none" data-icon draggable={false} />
                    )}
                    <span className="hover:saturate-200 focus:saturate-[25%] group-focus-within:saturate-[25%] peer-hover:saturate-200">
                      {domToReact(domNode.children as DOMNode[], options)}
                    </span>
                  </Link>
                ) : (
                  // different guide
                  <button
                    {...domNode.attribs}
                    className={cn(
                      '!contents group select-none data-[type=guide-step]:no-underline',
                      domNode.attribs.class,
                    )}
                    disabled={getGuide.isPending}
                    onClick={async () => {
                      if (guide) {
                        console.log('go to guide', domGuideId, stepNumber)
                        await navigate({
                          to: '/guides/$id',
                          params: { id: domGuideId },
                          search: { step: stepNumber - 1 },
                        })
                      } else {
                        const guide = await getGuide.mutateAsync(domGuideId)

                        await navigate({
                          to: '/downloads/$status',
                          params: { status: guide.status },
                          search: { page: 1, search: guide?.name },
                        })
                      }
                    }}
                  >
                    {!hasGoToGuideIcon && (
                      <img
                        src={goToStepIcon}
                        className="peer inline-flex size-5 select-none group-focus-within:saturate-[25%] group-hover:saturate-200"
                        data-icon
                        draggable={false}
                      />
                    )}
                    <span className="hover:saturate-200 focus:saturate-[25%] group-focus-within:saturate-[25%] peer-hover:saturate-200">
                      {domToReact(domNode.children as DOMNode[], options)}
                    </span>
                  </button>
                )}
              </div>
            )
          }
        }
        // #endregion

        // #region custom tags monster and quest
        if (
          domNode.attribs['data-type'] === 'custom-tag' &&
          (domNode.attribs.type === 'monster' ||
            domNode.attribs.type === 'quest' ||
            domNode.attribs.type === 'item' ||
            domNode.attribs.type === 'dungeon')
        ) {
          const name = domNode.attribs.name ?? ''
          const { class: nodeClassName, ...restAttribs } = domNode.attribs

          return (
            <div {...restAttribs} className={cn('!contents', nodeClassName)}>
              {domToReact([domNode.children[0]] as DOMNode[], options)}
              <button
                type="button"
                className="contents"
                onClick={async (evt) => {
                  // open in browser if ctrl/cmd is pressed
                  if (navigator.userAgent.includes('AppleWebKit') ? evt.metaKey : evt.ctrlKey) {
                    openGuideLink.mutate(
                      `https://dofusdb.fr/fr/database/${domNode.attribs.type === 'item' ? 'object' : domNode.attribs.type}/${domNode.attribs.dofusdbid}`,
                    )
                  } else {
                    await writeText(name)
                  }
                }}
              >
                <span className="hover:saturate-150 focus:saturate-[25%]">{name}</span>
              </button>
            </div>
          )
        }
        // #endregion

        // #region img
        if (domNode.name === 'img') {
          const imgSrc = domNode.attribs.src ?? ''
          const isIcon =
            !domNode.attribs.class?.includes('img-large') &&
            !domNode.attribs.class?.includes('img-medium') &&
            !domNode.attribs.class?.includes('img-small')
          const clickable = !isIcon && imgSrc !== '' && imgSrc.startsWith('http')

          return (
            <ImageWithOrigin
              {...domNode.attribs}
              onClick={() => {
                if (clickable) {
                  openGuideLink.mutate(imgSrc)
                }
              }}
              draggable={false}
              role="button"
              className={cn(
                'inline-flex select-none',
                isIcon && '-translate-y-0.5 text-[0.8em]',
                !isIcon && '!cursor-pointer',
                domNode.attribs.class,
              )}
            />
          )
        }
        // #endregion

        // #region a
        if (domNode.name === 'a') {
          const href = domNode.attribs.href ?? ''

          return (
            <button
              data-href={href}
              type="button"
              className="inline-flex"
              onClick={() => {
                if (href !== '' && href.startsWith('http')) {
                  openGuideLink.mutate(href)
                }
              }}
            >
              {domToReact(domNode.children as DOMNode[], options)}
            </button>
          )
        }
        // #endregion

        // #region <p> inside taskItem
        if (
          domNode.name === 'p' &&
          domNode.parent?.type === 'tag' &&
          domNode.parent.name === 'div' &&
          domNode.parent.parent?.type === 'tag' &&
          domNode.parent.parent.name === 'li' &&
          domNode.parent.parent.attribs['data-type'] === 'taskItem'
        ) {
          return <p className="contents">{domToReact(domNode.children as DOMNode[], options)}</p>
        }
        // #endregion

        // #region checkbox
        if (domNode.name === 'input' && domNode.attribs.type === 'checkbox') {
          const index = checkboxesCount++

          return (
            <input
              {...domNode.attribs}
              onChange={() => {
                toggleGuideCheckbox.mutate({
                  guideId,
                  checkboxIndex: index,
                  stepIndex,
                })
              }}
              checked={step.checkboxes.includes(index)}
            />
          )
        }
        // #endregion
      }
    },
  }

  return <div className={className}>{parse(html, options)}</div>
}
