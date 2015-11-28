// FIXME Better way to pack data in graphic element
define(function (require) {

    var TooltipContent = require('./tooltip/TooltipContent');
    var graphic = require('../util/graphic');
    var zrUtil = require('zrender/core/util');
    var formatUtil = require('../util/format');
    var numberUtil = require('../util/number');
    var parsePercent = numberUtil.parsePercent;

    require('./tooltip/TooltipModel');

    function dataEqual(a, b) {
        if (!a || !b) {
            return false;
        }
        var round = numberUtil.round;
        return round(a[0]) === round(b[0])
            && round(a[1]) === round(b[1]);
    }
    /**
     * @inner
     */
    function makeLineShape(x1, y1, x2, y2) {
        return {
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2
        };
    }

    /**
     * @inner
     */
    function makeRectShape(x, y, width, height) {
        return {
            x: x,
            y: y,
            width: width,
            height: height
        };
    }

    /**
     * @inner
     */
    function makeSectorShape(cx, cy, r0, r, startAngle, endAngle) {
        return {
            cx: cx,
            cy: cy,
            r0: r0,
            r: r,
            startAngle: startAngle,
            endAngle: endAngle,
            clockwise: true
        };
    }

    var TPL_VAR_ALIAS = ['a', 'b', 'c', 'd', 'e'];

    function wrapVar(varName, seriesIdx) {
        return '{' + varName + (seriesIdx == null ? '' : seriesIdx) + '}';
    }
    /**
     * @inner
     */
    function formatTpl(tpl, paramsList) {
        if (!zrUtil.isArray(paramsList)) {
            paramsList = [paramsList];
        }
        var seriesLen = paramsList.length;
        if (!seriesLen) {
            return '';
        }

        var $vars = paramsList[0].$vars;
        for (var i = 0; i < $vars.length; i++) {
            var alias = TPL_VAR_ALIAS[i];
            tpl = tpl.replace(wrapVar(alias),  wrapVar(alias, 0));
        }
        for (var seriesIdx = 0; seriesIdx < seriesLen; seriesIdx++) {
            for (var k = 0; k < $vars.length; k++) {
                tpl = tpl.replace(
                    wrapVar(TPL_VAR_ALIAS[k], seriesIdx),
                    paramsList[seriesIdx][$vars[k]]
                );
            }
        }

        return tpl;
    }

    function adjustedTooltipPosition(x, y, el, viewWidth, viewHeight) {
        var width = el.clientWidth;
        var height = el.clientHeight;
        var gap = 20;

        if (x + width + gap > viewWidth) {
            x -= width + gap;
        }
        else {
            x += gap;
        }
        if (y + height + gap > viewHeight) {
            y -= height + gap;
        }
        else {
            y += gap;
        }
        return [x, y];
    }

    require('../echarts').extendComponentView({

        type: 'tooltip',

        _axisPointers: {},

        init: function (ecModel, api) {
            var tooltipContent = new TooltipContent(api.getDom(), api);
            this._tooltipContent = tooltipContent;
        },

        render: function (tooltipModel, ecModel, api) {

            // Reset
            this.group.removeAll();

            /**
             * @type {Object}
             * @private
             */
            this._axisPointers = {};

            /**
             * @private
             * @type {module:echarts/component/tooltip/TooltipModel}
             */
            this._tooltipModel = tooltipModel;

            /**
             * @private
             * @type {module:echarts/model/Global}
             */
            this._ecModel = ecModel;

            /**
             * @private
             * @type {module:echarts/ExtensionAPI}
             */
            this._api = api;

            /**
             * @type {Object}
             * @private
             */
            this._lastHover = {
                // data
                // dataIndex
                // seriesIndex
            };

            var tooltipContent = this._tooltipContent;
            tooltipContent.update();
            tooltipContent.enterable = tooltipModel.get('enterbale');

            this._alwaysShowContent = tooltipModel.get('alwaysShowContent');

            /**
             * @type {Object.<string, Array>}
             */
            this._seriesGroupByAxis = this._prepareAxisTriggerData(
                tooltipModel, ecModel
            );

            var crossText = this._crossText;
            if (crossText) {
                this.group.add(crossText);
            }

            var zr = this._api.getZr();
            var tryShow = this._tryShow;
            zr.off('click', tryShow);
            zr.off('mousemove', tryShow);
            zr.off('mouseout', this._hide);
            if (tooltipModel.get('triggerOn') === 'click') {
                zr.on('click', tryShow, this);
            }
            else {
                zr.on('mousemove', tryShow, this);
                zr.on('mouseout', this._hide, this);
            }
        },

        _prepareAxisTriggerData: function (tooltipModel, ecModel) {
            // Prepare data for axis trigger
            var seriesGroupByAxis = {};
            ecModel.eachSeries(function (seriesModel) {
                var coordSys = seriesModel.coordinateSystem;
                var trigger = seriesModel.get('tooltip.trigger', true);
                // Ignore series use item tooltip trigger
                if (!coordSys ||  trigger === 'item') {
                    return;
                }

                var coordSysType = coordSys.type;

                var baseAxis;
                var key;

                // Only cartesian2d and polar support axis trigger
                if (coordSysType === 'cartesian2d') {
                    // FIXME `axisPointer.axis` is not baseAxis
                    baseAxis = coordSys.getBaseAxis();
                    var baseDim = baseAxis.dim;
                    var axisIndex = seriesModel.get(baseDim + 'AxisIndex');

                    key = baseDim + axisIndex;
                }
                else if (coordSysType === 'polar') {
                    baseAxis = coordSys.getBaseAxis();
                    key = baseAxis.dim + coordSys.name;
                }

                if (!key) {
                    return;
                }

                seriesGroupByAxis[key] = seriesGroupByAxis[key] || {
                    coordSys: [],
                    series: []
                };
                seriesGroupByAxis[key].coordSys.push(coordSys);
                seriesGroupByAxis[key].series.push(seriesModel);

            }, this);

            return seriesGroupByAxis;
        },

        /**
         * mousemove handler
         * @param {Object} e
         * @private
         */
        _tryShow: function (e) {
            var el = e.target;
            var tooltipModel = this._tooltipModel;
            var globalTrigger = tooltipModel.get('trigger');
            var ecModel = this._ecModel;

            if (!tooltipModel) {
                return;
            }

            // Always show item tooltip if mouse is on the element with dataIndex
            if (el && el.dataIndex != null) {
                // Use hostModel in element if possible
                // Used when mouseover on a element like markPoint or edge
                // In which case, the data is not main data in series.
                var hostModel = el.hostModel || ecModel.getSeriesByIndex(el.seriesIndex);
                var dataIndex = el.dataIndex;
                var itemModel = hostModel.getData().getItemModel(dataIndex);
                // Series or single data may use item trigger when global is axis trigger
                if ((itemModel.get('tooltip.trigger') || globalTrigger) === 'axis') {
                    this._showAxisTooltip(tooltipModel, ecModel, e);
                }
                else {
                    // Reset ticket
                    this._ticket = '';
                    // If either single data or series use item trigger
                    this._hideAxisPointer();
                    this._showItemTooltipContent(hostModel, dataIndex, e);
                }
            }
            else {
                if (globalTrigger === 'item') {
                    this._hide();
                }
                else {
                    // Try show axis tooltip
                    this._showAxisTooltip(tooltipModel, ecModel, e);
                }
            }
        },

        /**
         * Show tooltip on axis
         * @param {module:echarts/component/tooltip/TooltipModel} tooltipModel
         * @param {module:echarts/model/Global} ecModel
         * @param {Object} e
         * @private
         */
        _showAxisTooltip: function (tooltipModel, ecModel, e) {
            var axisPointerModel = tooltipModel.getModel('axisPointer');
            var axisPointerType = axisPointerModel.get('type');

            if (axisPointerType === 'cross') {
                var el = e.target;
                if (el && el.dataIndex != null) {
                    var seriesModel = ecModel.getSeriesByIndex(el.seriesIndex);
                    var dataIndex = el.dataIndex;
                    this._showItemTooltipContent(seriesModel, dataIndex, e);
                }
            }

            this._showAxisPointer();
            var allNotShow = true;
            zrUtil.each(this._seriesGroupByAxis, function (seriesCoordSysSameAxis) {
                // Try show the axis pointer
                var allCoordSys = seriesCoordSysSameAxis.coordSys;
                var coordSys = allCoordSys[0];

                // If mouse position is not in the grid or polar
                var point = [e.offsetX, e.offsetY];

                if (!coordSys.containPoint(point)) {
                    // Hide axis pointer
                    this._hideAxisPointer(coordSys.name);
                    return;
                }

                allNotShow = false;
                // Make sure point is discrete on cateogry axis
                var dimensions = coordSys.dimensions;
                var value = coordSys.pointToData(point, true);
                point = coordSys.dataToPoint(value);
                var baseAxis = coordSys.getBaseAxis();
                var axisType = axisPointerModel.get('axis');
                if (axisType === 'auto') {
                    axisType = baseAxis.dim;
                }

                var contentNotChange = false;
                var lastHover = this._lastHover;
                if (axisPointerType === 'cross') {
                    // If hover data not changed
                    // Possible when two axes are all category
                    if (dataEqual(lastHover.data, value)) {
                        contentNotChange = true;
                    }
                    lastHover.data = value;
                }
                else {
                    var valIndex = zrUtil.indexOf(dimensions, axisType);
                    // If hover data not changed on the axis dimension
                    if (lastHover.data === value[valIndex]) {
                        contentNotChange = true;
                    }
                    lastHover.data = value[valIndex];
                }

                if (coordSys.type === 'cartesian2d' && !contentNotChange) {
                    this._showCartesianPointer(
                        axisPointerModel, coordSys, axisType, point
                    );
                }
                else if (coordSys.type === 'polar' && !contentNotChange) {
                    this._showPolarPointer(
                        axisPointerModel, coordSys, axisType, point
                    );
                }

                if (axisPointerType !== 'cross') {
                    this._showSeriesTooltipContent(
                        coordSys, seriesCoordSysSameAxis.series, point, value, contentNotChange
                    );
                }
            }, this);

            if (allNotShow) {
                this._hide();
            }
        },

        /**
         * Show tooltip on axis of cartesian coordinate
         * @param {module:echarts/model/Model} axisPointerModel
         * @param {module:echarts/coord/cartesian/Cartesian2D} cartesians
         * @param {string} axisType
         * @param {Array.<number>} point
         * @private
         */
        _showCartesianPointer: function (axisPointerModel, cartesian, axisType, point) {
            var self = this;

            var axisPointerType = axisPointerModel.get('type');
            var moveAnimation = axisPointerType !== 'cross';

            if (axisPointerType === 'cross') {
                moveGridLine('x', point, cartesian.getAxis('y').getExtent());
                moveGridLine('y', point, cartesian.getAxis('x').getExtent());

                this._updateCrossText(cartesian, point, axisPointerModel);
            }
            else {
                var otherAxis = cartesian.getAxis(axisType === 'x' ? 'y' : 'x');
                var otherExtent = otherAxis.getExtent();

                if (cartesian.type === 'cartesian2d') {
                    (axisPointerType === 'line' ? moveGridLine : moveGridShadow)(
                        axisType, point, otherExtent
                    );
                }
            }

            /**
             * @inner
             */
            function moveGridLine(axisType, point, otherExtent) {
                var targetShape = axisType === 'x'
                    ? makeLineShape(point[0], otherExtent[0], point[0], otherExtent[1])
                    : makeLineShape(otherExtent[0], point[1], otherExtent[1], point[1]);

                var pointerEl = self._getPointerElement(
                    cartesian, axisPointerModel, axisType, targetShape
                );
                moveAnimation
                    ? pointerEl.animateTo({
                        shape: targetShape
                    }, 200, 'cubicOut')
                    :  pointerEl.attr({
                        shape: targetShape
                    });
            }

            /**
             * @inner
             */
            function moveGridShadow(axisType, point, otherExtent) {
                var axis = cartesian.getAxis(axisType);
                var bandWidth = axis.getBandWidth();
                var span = otherExtent[1] - otherExtent[0];
                var targetShape = axisType === 'x'
                    ? makeRectShape(point[0] - bandWidth / 2, otherExtent[0], bandWidth, span)
                    : makeRectShape(otherExtent[0], point[1] - bandWidth / 2, span, bandWidth);

                var pointerEl = self._getPointerElement(
                    cartesian, axisPointerModel, axisType, targetShape
                );
                moveAnimation
                    ? pointerEl.animateTo({
                        shape: targetShape
                    }, 200, 'cubicOut')
                    :  pointerEl.attr({
                        shape: targetShape
                    });
            }
        },

        /**
         * Show tooltip on axis of polar coordinate
         * @param {module:echarts/model/Model} axisPointerModel
         * @param {Array.<module:echarts/coord/polar/Polar>} polar
         * @param {string} axisType
         * @param {Array.<number>} point
         */
        _showPolarPointer: function (axisPointerModel, polar, axisType, point) {
            var self = this;

            var axisPointerType = axisPointerModel.get('type');

            var angleAxis = polar.getAngleAxis();
            var radiusAxis = polar.getRadiusAxis();

            var moveAnimation = axisPointerType !== 'cross';

            if (axisPointerType === 'cross') {
                movePolarLine('angle', point, radiusAxis.getExtent());
                movePolarLine('radius', point, angleAxis.getExtent());

                this._updateCrossText(polar, point, axisPointerModel);
            }
            else {
                var otherAxis = polar.getAxis(axisType === 'radius' ? 'angle' : 'radius');
                var otherExtent = otherAxis.getExtent();

                (axisPointerType === 'line' ? movePolarLine : movePolarShadow)(
                    axisType, point, otherExtent
                );
            }
            /**
             * @inner
             */
            function movePolarLine(axisType, point, otherExtent) {
                var mouseCoord = polar.pointToCoord(point);

                var targetShape;

                if (axisType === 'angle') {
                    var p1 = polar.coordToPoint([otherExtent[0], mouseCoord[1]]);
                    var p2 = polar.coordToPoint([otherExtent[1], mouseCoord[1]]);
                    targetShape = makeLineShape(p1[0], p1[1], p2[0], p2[1]);
                }
                else {
                    targetShape = {
                        cx: polar.cx,
                        cy: polar.cy,
                        r: mouseCoord[0]
                    };
                }

                var pointerEl = self._getPointerElement(
                    polar, axisPointerModel, axisType, targetShape
                );

                moveAnimation
                    ? pointerEl.animateTo({
                        shape: targetShape
                    }, 200, 'cubicOut')
                    :  pointerEl.attr({
                        shape: targetShape
                    });
            }

            /**
             * @inner
             */
            function movePolarShadow(axisType, point, otherExtent) {
                var axis = polar.getAxis(axisType);
                var bandWidth = axis.getBandWidth();

                var mouseCoord = polar.pointToCoord(point);

                var targetShape;

                var radian = Math.PI / 180;

                if (axisType === 'angle') {
                    targetShape = makeSectorShape(
                        polar.cx, polar.cy,
                        otherExtent[0], otherExtent[1],
                        // In ECharts y is negative if angle is positive
                        (-mouseCoord[1] - bandWidth / 2) * radian,
                        (-mouseCoord[1] + bandWidth / 2) * radian
                    );
                }
                else {
                    targetShape = makeSectorShape(
                        polar.cx, polar.cy,
                        mouseCoord[0] - bandWidth / 2,
                        mouseCoord[0] + bandWidth / 2,
                        0, Math.PI * 2
                    );
                }

                var pointerEl = self._getPointerElement(
                    polar, axisPointerModel, axisType, targetShape
                );
                moveAnimation
                    ? pointerEl.animateTo({
                        shape: targetShape
                    }, 200, 'cubicOut')
                    :  pointerEl.attr({
                        shape: targetShape
                    });
            }
        },

        _updateCrossText: function (coordSys, point, axisPointerModel) {
            var crossStyleModel = axisPointerModel.getModel('crossStyle');
            var textStyleModel = crossStyleModel.getModel('textStyle');

            var tooltipModel = this._tooltipModel;

            var text = this._crossText;
            if (!text) {
                text = this._crossText = new graphic.Text({
                    style: {
                        textAlign: 'left',
                        textBaseline: 'bottom'
                    }
                });
                this.group.add(text);
            }

            var value = coordSys.pointToData(point);

            var dims = coordSys.dimensions;
            value = zrUtil.map(value, function (val, idx) {
                var axis = coordSys.getAxis(dims[idx]);
                if (axis.type === 'category') {
                    val = axis.scale.getLabel(val);
                }
                else {
                    val = formatUtil.addCommas(
                        val.toFixed(axis.getFormatPrecision())
                    );
                }
                return val;
            });

            text.setStyle({
                fill: textStyleModel.get('color') || crossStyleModel.get('color'),
                textFont: textStyleModel.getFont(),
                text: value.join(', '),
                x: point[0] + 5,
                y: point[1] - 5
            });
            text.z = tooltipModel.get('z');
            text.zlevel = tooltipModel.get('zlevel');
        },

        _getPointerElement: function (coordSys, pointerModel, axisType, initShape) {
            var tooltipModel = this._tooltipModel;
            var z = tooltipModel.get('z');
            var zlevel = tooltipModel.get('zlevel');
            var axisPointers = this._axisPointers;
            var coordSysName = coordSys.name;
            axisPointers[coordSysName] = axisPointers[coordSysName] || {};
            if (axisPointers[coordSysName][axisType]) {
                return axisPointers[coordSysName][axisType];
            }

            // Create if not exists
            var pointerType = pointerModel.get('type');
            var styleModel = pointerModel.getModel(pointerType + 'Style');
            var isShadow = pointerType === 'shadow';
            var style = styleModel[isShadow ? 'getAreaStyle' : 'getLineStyle']();

            var elementType = coordSys.type === 'polar'
                ? (isShadow ? 'Sector' : (axisType === 'radius' ? 'Circle' : 'Line'))
                : (isShadow ? 'Rect' : 'Line');

           isShadow ? (style.stroke = null) : (style.fill = null);

            var el = axisPointers[coordSysName][axisType] = new graphic[elementType]({
                style: style,
                z: z,
                zlevel: zlevel,
                silent: true,
                shape: initShape
            });

            this.group.add(el);
            return el;
        },

        /**
         * Show tooltip on item
         * @param {Array.<module:echarts/model/Series>} seriesList
         * @param {Array.<number>} point
         * @param {Array.<number>} value
         * @param {boolean} contentNotChange
         * @param {Object} e
         */
        _showSeriesTooltipContent: function (
            coordSys, seriesList, point, value, contentNotChange
        ) {

            var rootTooltipModel = this._tooltipModel;
            var tooltipContent = this._tooltipContent;

            var data = seriesList[0].getData();
            var baseAxis = coordSys.getBaseAxis();

            var val = value[baseAxis.dim === 'x' ? 0 : 1];
            var dataIndex = data.indexOfNearest(baseAxis.dim, val);

            // FIXME Not here
            var lastHover = this._lastHover;
            if (lastHover.seriesIndex != null && !contentNotChange) {
                this._api.dispatch({
                    type: 'downplay',
                    seriesIndex: lastHover.seriesIndex,
                    dataIndex: lastHover.dataIndex
                });
            }
            // Dispatch highlight action
            if (!contentNotChange) {
                var seriesIndices = zrUtil.map(seriesList, function (series) {
                    return series.seriesIndex;
                });
                this._api.dispatch({
                    type: 'highlight',
                    seriesIndex: seriesIndices,
                    dataIndex: dataIndex
                });
                lastHover.seriesIndex = seriesIndices;
                lastHover.dataIndex = dataIndex;
            }

            if (baseAxis && rootTooltipModel.get('showContent')) {

                var formatter = rootTooltipModel.get('formatter');
                var positionFunc = rootTooltipModel.get('position');
                var html;

                var paramsList = zrUtil.map(seriesList, function (series) {
                    return series.getDataParams(dataIndex);
                });
                // If only one series
                // FIXME
                // if (paramsList.length === 1) {
                //     paramsList = paramsList[0];
                // }

                tooltipContent.show(rootTooltipModel);

                // Update html content
                if (!contentNotChange) {
                    // Reset ticket
                    this._ticket = '';
                    if (!formatter) {
                        // Default tooltip content
                        html = data.getName(dataIndex) + '<br />'
                            + zrUtil.map(seriesList, function (series) {
                                return series.formatTooltip(dataIndex, true);
                            }).join('<br />');
                    }
                    else {
                        if (typeof formatter === 'string') {
                            html = formatTpl(formatter, paramsList);
                        }
                        else if (typeof formatter === 'function') {
                            var self = this;
                            var ticket = 'axis_' + coordSys.name + '_' + dataIndex;
                            var callback = function (cbTicket, html) {
                                if (cbTicket === self._ticket) {
                                    tooltipContent.setContent(html);

                                    if (!positionFunc) {
                                        var pos = adjustedTooltipPosition(
                                            point[0], point[1], tooltipContent.el, viewWidth, viewHeight
                                        );
                                        x = pos[0];
                                        y = pos[1];
                                        tooltipContent.moveTo(x, y);
                                    }
                                }
                            };
                            self._ticket = ticket;
                            html = formatter(paramsList, ticket, callback);
                        }
                    }

                    tooltipContent.setContent(html);
                }

                var api = this._api;
                var viewWidth = api.getWidth();
                var viewHeight = api.getHeight();
                var x = point[0];
                var y = point[1];
                if (typeof positionFunc === 'function') {
                    var pos = positionFunc([x, y], paramsList);
                    x = parsePercent(pos[0], viewWidth);
                    y = parsePercent(pos[1], viewHeight);
                }
                else if (zrUtil.isArray(positionFunc)) {
                    x = parsePercent(positionFunc[0], viewWidth);
                    y = parsePercent(positionFunc[1], viewHeight);
                }
                else {
                    var pos = adjustedTooltipPosition(
                        x, y, tooltipContent.el, viewWidth, viewHeight
                    );
                    x = pos[0];
                    y = pos[1];
                }

                tooltipContent.moveTo(x, y);
            }
        },

        /**
         * Show tooltip on item
         * @param {module:echarts/model/Series} seriesModel
         * @param {number} dataIndex
         * @param {Object} e
         */
        _showItemTooltipContent: function (seriesModel, dataIndex, e) {
            // FIXME Graph data
            var api = this._api;
            var data = seriesModel.getData();
            var itemModel = data.getItemModel(dataIndex);

            var rootTooltipModel = this._tooltipModel;

            var tooltipContent = this._tooltipContent;

            var tooltipModel = itemModel.getModel('tooltip');

            // If series model
            if (tooltipModel.parentModel) {
                tooltipModel.parentModel.parentModel = rootTooltipModel;
            }
            else {
                tooltipModel.parentModel = this._tooltipModel;
            }

            if (tooltipModel.get('showContent')) {
                var formatter = tooltipModel.get('formatter');
                var positionFunc = tooltipModel.get('position');
                var params = seriesModel.getDataParams(dataIndex);
                var html;
                if (!formatter) {
                    html = seriesModel.formatTooltip(dataIndex);
                }
                else {
                    if (typeof formatter === 'string') {
                        html = formatTpl(formatter, params);
                    }
                    else if (typeof formatter === 'function') {
                        var self = this;
                        var ticket = 'item_' + seriesModel.name + '_' + dataIndex;
                        var callback = function (cbTicket, html) {
                            if (cbTicket === self._ticket) {
                                tooltipContent.setContent(html);
                                if (!positionFunc) {
                                    var pos = adjustedTooltipPosition(
                                        e.offsetX, e.offsetY, tooltipContent.el, viewWidth, viewHeight
                                    );
                                    x = pos[0];
                                    y = pos[1];
                                    tooltipContent.moveTo(x, y);
                                }
                            }
                        };
                        self._ticket = ticket;
                        html = formatter(params, ticket, callback);
                    }
                }

                tooltipContent.show(tooltipModel);
                tooltipContent.setContent(html);

                var x = e.offsetX;
                var y = e.offsetY;

                var viewWidth = api.getWidth();
                var viewHeight = api.getHeight();
                if (typeof positionFunc === 'function') {
                    var pos = positionFunc([x, y], params);
                    x = parsePercent(pos[0], viewWidth);
                    y = parsePercent(pos[1], viewHeight);
                }
                else if (zrUtil.isArray(positionFunc)) {
                    x = parsePercent(positionFunc[0], viewWidth);
                    y = parsePercent(positionFunc[1], viewHeight);
                }
                else {
                    var pos = adjustedTooltipPosition(
                        x, y, tooltipContent.el, viewWidth, viewHeight
                    );
                    x = pos[0];
                    y = pos[1];
                }

                tooltipContent.moveTo(x, y);
            }
        },

        /**
         * Show axis pointer
         * @param {string} [coordSysName]
         */
        _showAxisPointer: function (coordSysName) {
            if (coordSysName) {
                var axisPointers = this._axisPointers[coordSysName];
                axisPointers && zrUtil.each(axisPointers, function (el) {
                    el.show();
                });
            }
            else {
                this.group.eachChild(function (child) {
                    child.show();
                });
                this.group.show();
            }
        },
        /**
         * Hide axis pointer
         * @param {string} [coordSysName]
         */
        _hideAxisPointer: function (coordSysName) {
            var lastHover = this._lastHover;
            if (lastHover.seriesIndex != null && lastHover.dataIndex != null) {
                this._api.dispatch({
                    type: 'downplay',
                    seriesIndex: lastHover.seriesIndex,
                    dataIndex: lastHover.dataIndex
                });
            }
            // Reset lastHover
            this._lastHover = {};

            if (coordSysName) {
                var axisPointers = this._axisPointers[coordSysName];
                axisPointers && zrUtil.each(axisPointers, function (el) {
                    el.hide();
                });
            }
            else {
                this.group.hide();
            }
        },

        _hide: function () {
            this._hideAxisPointer();
            if (!this._alwaysShowContent) {
                this._tooltipContent.hideLater(this._tooltipModel.get('hideDelay'));
            }
        },

        dispose: function (api) {
            var zr = api.getZr();
            zr.off('click', this._tryShow);
            zr.off('mousemove', this._tryShow);
            zr.off('mouseout', this._hide);
        }
    });
});