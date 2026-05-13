import type CanvasRoi from './'
import { DistanceCheck, OperateCursor, Point, RoiPath } from '../types'
import { clickPathTypes } from './const'
import {
  getMousePoint,
  checkPointsEqual,
  getVirtualRectPoints,
  countDistance,
  fixRectPoints,
  pointInPolygon
} from './utils'

function keyPress(this: CanvasRoi, e: KeyboardEvent): void {
  const key = e.key.toLowerCase()
  switch (key) {
    case 'backspace':
    case 'delete':
      this._deletePath()
      break
    case 't':
      this._invertChosePath()
      break
    default:
      break
  }
}

function getRectEndPoint(this: CanvasRoi, truePoint: Point): Point {
  const [startPoint] = this.newPath.points
  const { rectAspectRatio: ratio } = this.$opts
  return ratio > 0
    ? { x: truePoint.x, y: startPoint.y + ratio * (truePoint.x - startPoint.x) }
    : truePoint
}

/**
 * 根据圆心和鼠标位置，返回受画布边界限制的圆形终点
 * 若 bounded = false 则直接返回鼠标位置
 */
function getCircleEndPoint(
  this: CanvasRoi,
  centerPoint: Point,
  mousePoint: Point
): Point {
  if (!this.$opts.bounded) return mousePoint

  const { x: cx, y: cy } = centerPoint
  const { width: w, height: h } = this.$cvsSize

  // 圆心到画布四边的最短距离 = 圆可拥有的最大半径
  const maxR = Math.min(cx, cy, w - cx, h - cy)
  if (maxR <= 0) return centerPoint // 圆心已在边界外，禁止扩大

  const dx = mousePoint.x - cx
  const dy = mousePoint.y - cy
  const dist = Math.hypot(dx, dy)

  // 未超出边界，直接返回鼠标位置
  if (dist <= maxR) return mousePoint

  // 超出时，沿鼠标方向截断到最大半径处
  return {
    x: cx + (dx / dist) * maxR,
    y: cy + (dy / dist) * maxR
  }
}

/**
 * 检查矩形是否超出边界（支持默认矩形和自定义菱形）
 */
function isRectOutBounded(
  this: CanvasRoi,
  startPoint: Point,
  endPoint: Point
): boolean {
  if (!this.$opts.bounded) return false
  const testPoints = getVirtualRectPoints([startPoint, endPoint])
  if (this.$opts.boundary?.length === 4) {
    const boundaryPx = this.$opts.boundary.map((p) => this.invert(p, false))
    return !testPoints.every((p) => pointInPolygon(p, boundaryPx))
  }
  const { width: w, height: h } = this.$cvsSize
  return !testPoints.every((p) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h)
}

function dragDrawingHandle(this: CanvasRoi, e: MouseEvent) {
  const { type, points } = this.newPath
  if (!this.dragging) {
    this.dragging = !checkPointsEqual(points[0], getMousePoint(e))
  }
  const rawPoint = getMousePoint(e)

  if (type === 'circle') {
    const constrainedEnd = getCircleEndPoint.call(this, points[0], rawPoint)
    this._drawRoiPaths(constrainedEnd)
    return
  }

  // 矩形：先应用宽高比，再检查边界
  let endPoint = rawPoint
  if (type === 'rect') {
    endPoint = getRectEndPoint.call(this, rawPoint)
    if (isRectOutBounded.call(this, points[0], endPoint)) return // 越界则阻挡
  } else {
    endPoint = this._clampPointToBoundary(rawPoint)
  }
  this._drawRoiPaths(endPoint)
}

function checkPointsNearly(
  this: CanvasRoi,
  oPoint: Point,
  dPoint: Point,
  cusDistanceCheck?: DistanceCheck
): boolean {
  const { distanceCheck, canvasScale } = this.$opts
  const checkValue = cusDistanceCheck || distanceCheck
  return typeof checkValue === 'function'
    ? checkValue(oPoint, dPoint)
    : Math.abs(oPoint.x - dPoint.x) < checkValue * canvasScale &&
        Math.abs(oPoint.y - dPoint.y) < checkValue * canvasScale
}

function clickDrawingHandle(this: CanvasRoi, e: MouseEvent) {
  let endPoint = this._clampPointToBoundary(getMousePoint(e))
  const { points } = this.newPath
  this.pathPointsCoincide = false

  if (points.length > 2) {
    const startPoint = points[0]
    if (checkPointsNearly.call(this, endPoint, startPoint)) {
      endPoint = startPoint
      this.pathPointsCoincide = true
    }
  }
  this._drawRoiPaths(endPoint)
}

function polygonAddPoint(
  this: CanvasRoi,
  points: Point[],
  point: Point,
  lineIndex: number
) {
  points.splice(lineIndex + 1, 0, point)
  Object.assign(this.operateCursor as OperateCursor, {
    pointIndex: lineIndex + 1,
    lineIndex: -1
  })
}

/** 处理选区的修改 */
function modifyChosePath(this: CanvasRoi, e: MouseEvent) {
  const rawNewPoint = getMousePoint(e)
  const newPoint = this._clampPointToBoundary(rawNewPoint)

  const {
    startPoint: { x, y } = { x: 0, y: 0 },
    pathIndex = -1,
    pointIndex = -1,
    lineIndex,
    inPath
  } = this.operateCursor || {}
  if (!this.paths[pathIndex]) return
  const { type, points } = this.paths[pathIndex]

  // 修改圆的半径/角度
  if (!inPath && type === 'circle') {
    const constrainedEnd = getCircleEndPoint.call(this, points[0], rawNewPoint)
    points[1] = constrainedEnd
    this._drawRoiPathsWithOpe(constrainedEnd)
    return
  }

  const isRect = type === 'rect'
  const { bounded } = this.$opts
  const hasCustomBoundary = !!(bounded && this.$opts.boundary?.length === 4)

  // 默认边界轴向检测
  let xOut = false,
    yOut = false
  if (bounded && !hasCustomBoundary) {
    const { width: cvsW, height: cvsH } = this.$cvsSize
    xOut = points.some((pt: Point) => {
      const newX = pt.x + (rawNewPoint.x - x)
      return newX < 0 || newX > cvsW
    })
    yOut = points.some((pt: Point) => {
      const newY = pt.y + (rawNewPoint.y - y)
      return newY < 0 || newY > cvsH
    })
  }

  const rawDistance = [rawNewPoint.x - x, rawNewPoint.y - y]
  const distance = [newPoint.x - x, newPoint.y - y]
  this.operateCursor && (this.operateCursor.startPoint = newPoint)

  const pointMove = (point: Point, xStatic?: boolean, yStatic?: boolean) => {
    !xStatic && (point.x += distance[0])
    !yStatic && (point.y += distance[1])
  }

  // 整体移动
  if (inPath) {
    if (type === 'circle') {
      const [center, end] = points
      const shiftedCenter = {
        x: center.x + rawDistance[0],
        y: center.y + rawDistance[1]
      }
      const shiftedEnd = {
        x: end.x + rawDistance[0],
        y: end.y + rawDistance[1]
      }
      if (bounded) {
        const currentR = countDistance(center, end)
        const { x: scx, y: scy } = shiftedCenter
        const { width: w, height: h } = this.$cvsSize
        const maxR = Math.min(scx, scy, w - scx, h - scy)
        if (maxR >= currentR) {
          Object.assign(center, shiftedCenter)
          Object.assign(end, shiftedEnd)
        }
      } else {
        Object.assign(center, shiftedCenter)
        Object.assign(end, shiftedEnd)
      }
      this._drawRoiPaths()
      return
    }

    if (hasCustomBoundary) {
      const boundaryPx = this.$opts.boundary!.map((p) => this.invert(p, false))
      const testPoints = isRect ? getVirtualRectPoints(points) : points
      const tempPoints = testPoints.map((pt) => ({
        x: pt.x + rawDistance[0],
        y: pt.y + rawDistance[1]
      }))
      if (tempPoints.every((p) => pointInPolygon(p, boundaryPx))) {
        points.forEach((pt: Point) => {
          pt.x += rawDistance[0]
          pt.y += rawDistance[1]
        })
      }
    } else {
      points.forEach((pt: Point) => pointMove(pt, xOut, yOut))
    }
    this._drawRoiPaths()
    return
  }

  // 移动单个顶点
  if (pointIndex >= 0) {
    const rectPointsMove = (idx: number) => {
      if (idx === 1) {
        points[0].y += distance[1]
        points[1].x += distance[0]
      } else if (idx === 3) {
        points[0].x += distance[0]
        points[1].y += distance[1]
      } else {
        pointMove(points[idx / 2])
      }
    }
    isRect ? rectPointsMove(pointIndex) : pointMove(points[pointIndex])

    if (hasCustomBoundary) {
      if (isRect) {
        points[0] = this._clampPointToBoundary(points[0])
        points[1] = this._clampPointToBoundary(points[1])
      } else {
        points[pointIndex] = this._clampPointToBoundary(points[pointIndex])
      }
    }
    this._drawRoiPathsWithOpe(isRect ? undefined : newPoint)
    return
  }

  // 移动边
  if (lineIndex !== undefined && lineIndex >= 0) {
    if (isRect) {
      const ratio = this.$opts.rectAspectRatio
      // 备份原始坐标，用于越界回退
      const origP0 = { ...points[0] }
      const origP1 = { ...points[1] }

      if (lineIndex % 3 === 0) {
        pointMove(points[0], lineIndex === 0, lineIndex === 3)
      } else {
        pointMove(points[1], lineIndex === 2, lineIndex === 1)
      }
      if (ratio > 0) {
        const p0 = points[0],
          p1 = points[1]
        const dx = p1.x - p0.x,
          dy = p1.y - p0.y
        const signX = dx === 0 ? 1 : dx > 0 ? 1 : -1
        const signY = dy === 0 ? 1 : dy > 0 ? 1 : -1
        if (lineIndex === 0 || lineIndex === 2) {
          const absHeight = Math.abs(dy)
          const absWidth = absHeight / ratio
          p1.x = p0.x + signX * absWidth
        } else {
          const absWidth = Math.abs(dx)
          const absHeight = absWidth * ratio
          p1.y = p0.y + signY * absHeight
        }
      }

      // 越界回退
      if (isRectOutBounded.call(this, points[0], points[1])) {
        points[0].x = origP0.x
        points[0].y = origP0.y
        points[1].x = origP1.x
        points[1].y = origP1.y
        this._drawRoiPaths()
        return
      }

      if (hasCustomBoundary) {
        points[0] = this._clampPointToBoundary(points[0])
        points[1] = this._clampPointToBoundary(points[1])
      }
    } else {
      polygonAddPoint.call(this, points, newPoint, lineIndex)
    }
    this._drawRoiPathsWithOpe(isRect ? undefined : newPoint)
  }
}

function checkPointLocalInPath(
  this: CanvasRoi,
  points: Point[],
  ckPoint: Point
) {
  if (!this.$ctx) return
  const { length } = points
  const {
    canvasScale,
    sensitive: { point },
    rectAspectRatio
  } = this.$opts
  const isRatio = rectAspectRatio > 0
  for (let i = 0; i < length; i += 1) {
    const start = points[i]
    const end = points[(i + 1) % length]
    const pointSen = point * canvasScale
    const nearCorer = checkPointsNearly.call(this, start, ckPoint, pointSen)
      ? i
      : checkPointsNearly.call(this, end, ckPoint, pointSen)
      ? i + 1
      : -1
    if (!isRatio && nearCorer > -1) {
      return { pointIndex: nearCorer }
    }
    this.$ctx.beginPath()
    this.$ctx.moveTo(start.x, start.y)
    this.$ctx.lineTo(end.x, end.y)
    this.$ctx.closePath()
    if (this.$ctx.isPointInStroke(ckPoint.x, ckPoint.y)) {
      return { lineIndex: i }
    }
  }
  return
}

function getMousePosition(
  this: CanvasRoi,
  path: RoiPath,
  point: Point,
  idx?: number,
  checkInPath?: boolean
) {
  if (!this.$ctx) return
  const { type, points } = path
  const {
    canvasScale,
    sensitive: { line },
    pathCanMove
  } = this.$opts
  this.$ctx.save()
  this.$ctx.lineWidth = line * canvasScale
  let result = false

  if (type === 'rect' || type === 'polygon') {
    const checkPoints = type === 'rect' ? getVirtualRectPoints(points) : points
    const info = checkPointLocalInPath.call(this, checkPoints, point)
    info &&
      (result = true) &&
      (this.operateCursor = { pathType: type, pathIndex: idx, ...info })
  } else if (type === 'circle') {
    this._createCvsPath(type, points)
    result = this.$ctx.isPointInStroke(point.x, point.y)
    result && (this.operateCursor = { pathType: 'circle', pathIndex: idx })
  }
  if (pathCanMove && checkInPath) {
    this._createCvsPath(type, points)
    const checkFn = type === 'line' ? 'isPointInStroke' : 'isPointInPath'
    result = this.$ctx[checkFn](point.x, point.y)
    result &&
      (this.operateCursor = { pathType: type, pathIndex: idx, inPath: true })
  }
  this.$ctx.restore()
  return result
}

function checkMouseCanOperate(this: CanvasRoi, e?: MouseEvent): void {
  if (!this.$cvs) return
  const point = e ? getMousePoint(e) : undefined
  if (!point) return
  this.operateCursor = null
  this.$cvs.style.cursor = 'inherit'
  const {
    paths,
    choseIndex,
    $opts: { operateFocusOnly }
  } = this
  if (operateFocusOnly) {
    if (paths[choseIndex]) {
      getMousePosition.call(this, paths[choseIndex], point, choseIndex)
      !this.operateCursor &&
        getMousePosition.call(this, paths[choseIndex], point, choseIndex, true)
    }
  } else {
    this.paths.some((path: RoiPath, idx: number) =>
      getMousePosition.call(this, path, point, idx)
    )
    !this.operateCursor &&
      this.paths.some((path: RoiPath, idx: number) =>
        getMousePosition.call(this, path, point, idx, true)
      )
  }
  let drawOpeCircle = false
  if (this.operateCursor) {
    const {
      pathType,
      lineIndex,
      pointIndex,
      inPath,
      pathIndex
    } = this.operateCursor
    if (!inPath && pathType === 'rect') {
      const { side, corner } = this.$opts.rectCursors
      this.$cvs.style.cursor =
        pointIndex > -1 ? corner[pointIndex] : side[lineIndex]
    } else if (inPath) {
      pathIndex === choseIndex && (this.$cvs.style.cursor = 'move')
    } else {
      drawOpeCircle = true
    }
  }
  this._drawRoiPathsWithOpe(drawOpeCircle ? point : undefined)
}

function cvsMouseMove(this: CanvasRoi, e: MouseEvent): void {
  const { drawing, needDrag, dragging, modifying, lastMoveEvent } = this
  if (((drawing && needDrag && dragging) || modifying) && e.buttons !== 1) {
    this._cvsMouseUp(lastMoveEvent as MouseEvent)
    return
  }
  drawing
    ? needDrag
      ? dragDrawingHandle.call(this, e)
      : clickDrawingHandle.call(this, e)
    : modifying
    ? modifyChosePath.call(this, e)
    : checkMouseCanOperate.call(this, e)
  this.lastMoveEvent = e
}

function drawingPoint(this: CanvasRoi, e: MouseEvent) {
  if (!this.drawing) {
    const point = this._clampPointToBoundary(getMousePoint(e))
    this._createNewPath(point, 'point', false)
    this._addNewPath()
  }
}

function drawingLine(this: CanvasRoi, e: MouseEvent) {
  if (!this.drawing) {
    const startPoint = this._clampPointToBoundary(getMousePoint(e))
    this._createNewPath(startPoint, 'line', false)
  } else {
    const newPoint = this._clampPointToBoundary(getMousePoint(e))
    this.newPath.points.push(newPoint)
    this._addNewPath()
  }
}

function drawingPolygon(this: CanvasRoi, e: MouseEvent) {
  if (!this.drawing) {
    const startPoint = this._clampPointToBoundary(getMousePoint(e))
    this._createNewPath(startPoint, 'polygon', false)
  } else if (this.pathPointsCoincide) {
    this._addNewPath()
  } else {
    const newPoint = this._clampPointToBoundary(getMousePoint(e))
    this.newPath.points.push(newPoint)
  }
}

function cvsMouseClick(this: CanvasRoi, e: MouseEvent): void {
  e.preventDefault()
  if (!this.$cvs) return
  this.$cvs.focus()
  const { drawing, needDrag, modifying } = this
  if (
    this._isPathMax() ||
    !this._isSingleTypeAllow() ||
    (drawing && needDrag) ||
    modifying
  )
    return
  const pos = getMousePoint(e)
  if (e.type === 'contextmenu') {
    drawing &&
      (this.newPath.type === 'polygon'
        ? this.newPath.points.pop()
        : this._resetNewPath())
  } else {
    const { singleType, allowTypes } = this.$opts
    if (
      singleType &&
      (clickPathTypes as string[]).includes(this.curSingleType) &&
      (allowTypes as string[]).includes(this.curSingleType)
    ) {
      switch (this.curSingleType) {
        case 'polygon':
          drawingPolygon.call(this, e)
          break
        case 'point':
          drawingPoint.call(this, e)
          break
        case 'line':
          drawingLine.call(this, e)
          break
        default:
          break
      }
    } else if (!singleType && e.shiftKey && allowTypes.includes('polygon')) {
      drawingPolygon.call(this, e)
    }
  }
  this._drawRoiPaths(pos)
}

function cvsMouseDown(this: CanvasRoi, e: MouseEvent): void {
  e.preventDefault()
  if (e.buttons >= 2) return

  if (
    this.operateCursor &&
    (!this.operateCursor.inPath ||
      this.operateCursor.pathIndex === this.choseIndex)
  ) {
    this.modifying = true
    this._emitEvent('onModifyStart', e)
    const clamped = this._clampPointToBoundary(getMousePoint(e))
    this.operateCursor.originStartPoint = clamped
    this.operateCursor.startPoint = clamped
    return
  }

  if (
    this._isPathMax() ||
    !this._isSingleTypeAllow(true) ||
    (!this.$opts.singleType && e.shiftKey)
  )
    return
  const type = this.curSingleType || (e.ctrlKey ? 'circle' : 'rect')
  if (!this.$opts.allowTypes.includes(type)) return
  const startPoint = this._clampPointToBoundary(getMousePoint(e))
  this._createNewPath(startPoint, type)
  this._drawRoiPaths()
}

function addDragPath(this: CanvasRoi, endPoint: Point) {
  const { type, points } = this.newPath
  const startPoint = points[0]
  if (type === 'rect') {
    this.newPath.points = fixRectPoints(startPoint, endPoint)
  } else if (type === 'circle') {
    points.push(endPoint)
  }
  this._addNewPath()
}

function checkRoiValid(this: CanvasRoi, startPoint: Point, endPoint: Point) {
  const { tinyRectSize, tinyCircleRadius, canvasScale: cs } = this.$opts
  const { type } = this.newPath
  const tinyValue = type === 'rect' ? tinyRectSize : tinyCircleRadius
  return tinyValue > 0
    ? type === 'rect'
      ? Math.abs(startPoint.x - endPoint.x) > tinyValue * cs &&
        Math.abs(startPoint.y - endPoint.y) > tinyValue * cs
      : countDistance(startPoint, endPoint) > tinyValue * cs
    : !checkPointsEqual(startPoint, endPoint)
}

function checkMouseInPaths(this: CanvasRoi, pos: Point) {
  if (!this.$ctx) return -1
  this.$ctx.save()
  const index = this.paths.findIndex((path: RoiPath) => {
    if (!this.$ctx) return
    this._createCvsPath(path.type, path.points)
    const checkFn = path.type === 'line' ? 'isPointInStroke' : 'isPointInPath'
    return this.$ctx[checkFn](pos.x, pos.y)
  })
  this.$ctx.restore()
  return index
}

function checkPathFocus(this: CanvasRoi, point: Point) {
  const choseIndex = checkMouseInPaths.call(this, point)
  !(this.$opts.ignoreInvalidSelect && choseIndex === -1) &&
    this.choosePath(choseIndex)
}

function cvsMouseUp(this: CanvasRoi, e: MouseEvent): void {
  const rawEndPoint = getMousePoint(e)
  let endPoint: Point

  if (this.drawing && this.needDrag && this.dragging) {
    if (this.newPath.type === 'circle') {
      endPoint = getCircleEndPoint.call(
        this,
        this.newPath.points[0],
        rawEndPoint
      )
    } else if (this.newPath.type === 'rect') {
      endPoint = getRectEndPoint.call(this, rawEndPoint)
      if (isRectOutBounded.call(this, this.newPath.points[0], endPoint)) {
        this._resetNewPath()
        return
      }
    } else {
      endPoint = this._clampPointToBoundary(rawEndPoint)
    }
    checkRoiValid.call(this, this.newPath.points[0], endPoint)
      ? addDragPath.call(this, endPoint)
      : this._resetNewPath()
    return
  }

  endPoint = this._clampPointToBoundary(rawEndPoint)
  if (this.modifying) {
    this.modifying = false
    const { originStartPoint = {} as Point } = this
      .operateCursor as OperateCursor
    !checkPointsEqual(originStartPoint, endPoint) &&
      this._emitValue('modify', this.choseIndex)
  } else if (this.$opts.readonly) {
    checkPathFocus.call(this, endPoint)
    this._drawRoiPaths()
  } else if (!e.shiftKey && (!this.$opts.singleType || !this.curSingleType)) {
    this._resetNewPath()
    checkPathFocus.call(this, endPoint)
    checkMouseCanOperate.call(this, e)
  }
}

export default {
  keyPress,
  cvsMouseUp,
  cvsMouseDown,
  cvsMouseMove,
  cvsMouseClick,
  checkMouseCanOperate
}
